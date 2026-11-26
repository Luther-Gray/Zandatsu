(function () {
  let zandatsuTool = null;
  let discardSideSelect = null;
  let zandatsuToolbar = null;

  function getDiscardSign() {
    return discardSideSelect && discardSideSelect.value === "right" ? -1 : 1;
  }

  /**
   * Convert a mouse event (or preview.mouse fallback) to Normalized Device Coordinates.
   */
  function screenCursorNdcFromEvent(event, preview) {
    if (!preview) return null;
    if (event && typeof event.clientX === "number" && preview.canvas && preview.width && preview.height) {
      const rect = preview.canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / preview.width) * 2 - 1,
        y: -((event.clientY - rect.top) / preview.height) * 2 + 1,
      };
    }
    if (preview.mouse) {
      return { x: preview.mouse.x, y: preview.mouse.y };
    }
    return null;
  }

  /**
   * Compute the screen-space angle (in radians) from the pivot to the cursor.
   * Falls back to preview.mouse (NDC) when event is unavailable (e.g. raycast miss).
   */
  function screenAngleFromEvent(event, preview, pivotNdc) {
    const cursor = screenCursorNdcFromEvent(event, preview);
    if (!cursor) return null;

    const pivotX = pivotNdc ? pivotNdc.x : 0;
    const pivotY = pivotNdc ? pivotNdc.y : 0;
    const dx = (cursor.x - pivotX) * (preview.width / 2);
    const dy = (cursor.y - pivotY) * (preview.height / 2);
    if (dx === 0 && dy === 0) return null;
    return Math.atan2(dy, dx);
  }

  /**
   * Build a world-space THREE.Plane from the screen-space cut line.
   * Positive distance = keep side; negative distance = discard (red) side.
   */
  function buildCutPlane(angle, preview, pivotNdc) {
    if (!preview || !preview.camera || !preview.width || !preview.height) {
      return null;
    }

    preview.camera.updateMatrixWorld();

    const halfW = preview.width / 2;
    const halfH = preview.height / 2;
    const step = Math.min(halfW, halfH) * 0.5;

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const dx = (cos * step) / halfW;
    const dy = (sin * step) / halfH;

    // Discard side: left (-sin, cos) when +1, right (sin, -cos) when -1
    const sideSign = getDiscardSign();
    const lx = (-sin * sideSign * step) / halfW;
    const ly = (cos * sideSign * step) / halfH;

    const px = pivotNdc ? pivotNdc.x : 0;
    const py = pivotNdc ? pivotNdc.y : 0;

    const p0 = new THREE.Vector3(px, py, 0).unproject(preview.camera);
    const p1 = new THREE.Vector3(px + dx, py + dy, 0).unproject(preview.camera);
    const p2 = new THREE.Vector3(px, py, 0.5).unproject(preview.camera);
    const pDiscard = new THREE.Vector3(px + lx, py + ly, 0).unproject(preview.camera);

    const plane = new THREE.Plane().setFromCoplanarPoints(p0, p1, p2);
    if (plane.distanceToPoint(pDiscard) > 0) {
      plane.negate();
    }
    return plane;
  }

  const PLANE_EPSILON = 1e-5;

  /**
   * Classify every face of a Mesh as keep, discard, or straddling relative to plane.
   */
  function classifyMeshFaces(mesh, plane) {
    const keep = [];
    const discard = [];
    const straddling = [];

    if (!mesh || !mesh.mesh || !plane) {
      return { keep, discard, straddling };
    }

    mesh.mesh.updateMatrixWorld();

    const worldPos = new THREE.Vector3();
    const vertexDistances = {};
    for (const vkey in mesh.vertices) {
      worldPos.fromArray(mesh.vertices[vkey]);
      mesh.mesh.localToWorld(worldPos);
      vertexDistances[vkey] = plane.distanceToPoint(worldPos);
    }

    for (const fkey in mesh.faces) {
      const face = mesh.faces[fkey];
      let hasKeep = false;
      let hasDiscard = false;

      for (const vkey of face.vertices) {
        const d = vertexDistances[vkey];
        if (d === undefined) continue;
        if (d > PLANE_EPSILON) {
          hasKeep = true;
        } else if (d < -PLANE_EPSILON) {
          hasDiscard = true;
        }
      }

      if (hasKeep && hasDiscard) {
        straddling.push(fkey);
      } else if (hasDiscard) {
        discard.push(fkey);
      } else {
        keep.push(fkey);
      }
    }

    return { keep, discard, straddling, vertexDistances };
  }

  function interpolateEdgeUV(face, mesh, vA, vB, t, localPos) {
    const uvA = face.uv && face.uv[vA];
    const uvB = face.uv && face.uv[vB];
    if (uvA && uvB) {
      return [
        uvA[0] + (uvB[0] - uvA[0]) * t,
        uvA[1] + (uvB[1] - uvA[1]) * t,
      ];
    }
    if (typeof face.localToUV === "function") {
      return face.localToUV(new THREE.Vector3(localPos[0], localPos[1], localPos[2]));
    }
    return [0, 0];
  }

  function addCutFacePolygon(mesh, origFace, vkeys, uvByVkey) {
    // Degenerate-face guard: require 3 or 4 unique vertices.
    const unique = [];
    for (const vkey of vkeys) {
      if (!unique.includes(vkey)) unique.push(vkey);
    }
    if (unique.length < 3) {
      console.warn("[Zandatsu] Skipping degenerate cut face with < 3 unique vertices:", vkeys);
      return null;
    }

    const newFace = new MeshFace(mesh, {
      vertices: unique,
      texture: origFace.texture,
    });
    if (typeof origFace.getAngleTo === "function" && origFace.getAngleTo(newFace) > 90) {
      newFace.invert();
    }
    for (const vkey of newFace.vertices) {
      const uv = uvByVkey[vkey];
      newFace.uv[vkey] = uv ? [uv[0], uv[1]] : [0, 0];
    }
    return mesh.addFaces(newFace)[0];
  }

  /**
   * Slice a straddling face along plane, keeping only the positive half.
   * Reuses edgeCutCache across faces in the same mesh for watertight shared edges.
   */
  function cutFace(mesh, fkey, plane, vertexDistances, edgeCutCache) {
    const face = mesh.faces[fkey];
    if (!face) return;

    const sorted = face.getSortedVertices();
    if (!sorted || sorted.length < 3) {
      delete mesh.faces[fkey];
      return;
    }

    const keepRing = [];
    const uvByVkey = {};

    for (let i = 0; i < sorted.length; i++) {
      const vA = sorted[i];
      const vB = sorted[(i + 1) % sorted.length];
      const dA = vertexDistances[vA];
      const dB = vertexDistances[vB];

      if (dA >= -PLANE_EPSILON) {
        if (keepRing[keepRing.length - 1] !== vA) {
          keepRing.push(vA);
          uvByVkey[vA] = face.uv && face.uv[vA] ? face.uv[vA].slice() : [0, 0];
        }
      }

      const strictlyOpposite =
        (dA > PLANE_EPSILON && dB < -PLANE_EPSILON) ||
        (dA < -PLANE_EPSILON && dB > PLANE_EPSILON);

      if (strictlyOpposite) {
        const t = dA / (dA - dB);
        const posA = mesh.vertices[vA];
        const posB = mesh.vertices[vB];
        const localPos = [
          posA[0] + (posB[0] - posA[0]) * t,
          posA[1] + (posB[1] - posA[1]) * t,
          posA[2] + (posB[2] - posA[2]) * t,
        ];

        const edgeKey = vA < vB ? `${vA}:${vB}` : `${vB}:${vA}`;
        let newVkey = edgeCutCache[edgeKey];
        if (!newVkey) {
          newVkey = mesh.addVertices(localPos)[0];
          edgeCutCache[edgeKey] = newVkey;
          vertexDistances[newVkey] = 0;
        }

        if (keepRing[keepRing.length - 1] !== newVkey) {
          keepRing.push(newVkey);
        }
        uvByVkey[newVkey] = interpolateEdgeUV(face, mesh, vA, vB, t, localPos);
      }
    }

    // Deduplicate wrap-around if first and last match
    if (keepRing.length > 1 && keepRing[0] === keepRing[keepRing.length - 1]) {
      keepRing.pop();
    }

    delete mesh.faces[fkey];

    if (keepRing.length < 3) {
      console.warn("[Zandatsu] Skipping degenerate clipped ring:", keepRing);
      return;
    }

    if (keepRing.length === 3 || keepRing.length === 4) {
      addCutFacePolygon(mesh, face, keepRing, uvByVkey);
    } else if (keepRing.length === 5) {
      addCutFacePolygon(mesh, face, [keepRing[0], keepRing[1], keepRing[2], keepRing[3]], uvByVkey);
      addCutFacePolygon(mesh, face, [keepRing[0], keepRing[3], keepRing[4]], uvByVkey);
    } else {
      for (let i = 1; i < keepRing.length - 1; i++) {
        addCutFacePolygon(mesh, face, [keepRing[0], keepRing[i], keepRing[i + 1]], uvByVkey);
      }
    }
  }

  function polygonSignedArea2D(points) {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      area += a.x * b.y - b.x * a.y;
    }
    return area * 0.5;
  }

  function pointInPolygon2D(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x;
      const yi = poly[i].y;
      const xj = poly[j].x;
      const yj = poly[j].y;
      const intersect =
        yi > pt.y !== yj > pt.y &&
        pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function isConvexCCW2D(points) {
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const c = points[(i + 2) % points.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cross <= 1e-7) return false;
    }
    return true;
  }

  function earClipFallback(contour2D) {
    const indices = contour2D.map((_, i) => i);
    const tris = [];
    let guard = 0;
    const maxSteps = indices.length * indices.length + 16;

    while (indices.length > 3 && guard++ < maxSteps) {
      let clipped = false;
      for (let i = 0; i < indices.length; i++) {
        const iPrev = indices[(i - 1 + indices.length) % indices.length];
        const iCurr = indices[i];
        const iNext = indices[(i + 1) % indices.length];
        const a = contour2D[iPrev];
        const b = contour2D[iCurr];
        const c = contour2D[iNext];
        const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (cross <= 1e-9) continue;

        let containsOther = false;
        const tri = [a, b, c];
        for (let j = 0; j < indices.length; j++) {
          const idx = indices[j];
          if (idx === iPrev || idx === iCurr || idx === iNext) continue;
          if (pointInPolygon2D(contour2D[idx], tri)) {
            containsOther = true;
            break;
          }
        }
        if (containsOther) continue;

        tris.push([iPrev, iCurr, iNext]);
        indices.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) break;
    }
    if (indices.length === 3) {
      tris.push([indices[0], indices[1], indices[2]]);
    }
    return tris;
  }

  /**
   * Cap any closed boundary loops left lying on the cutting plane.
   * Ensures cap normals point toward the discarded half (-plane.normal).
   */
  function capCutPlane(mesh, plane, vertexDistances, fallbackTexture) {
    const edgeCounts = {};
    const edgePairs = {};
    const edgeTexture = {};

    for (const fkey in mesh.faces) {
      const face = mesh.faces[fkey];
      const edges = face.getEdges();
      for (const [vA, vB] of edges) {
        const key = vA < vB ? `${vA}:${vB}` : `${vB}:${vA}`;
        edgeCounts[key] = (edgeCounts[key] || 0) + 1;
        if (!edgePairs[key]) {
          edgePairs[key] = [vA, vB];
          edgeTexture[key] = face.texture;
        }
      }
    }

    const boundaryEdges = [];
    for (const key in edgeCounts) {
      if (edgeCounts[key] !== 1) continue;
      const [vA, vB] = edgePairs[key];
      const dA = vertexDistances[vA];
      const dB = vertexDistances[vB];
      if (
        dA !== undefined &&
        dB !== undefined &&
        Math.abs(dA) <= PLANE_EPSILON &&
        Math.abs(dB) <= PLANE_EPSILON
      ) {
        boundaryEdges.push({ key, vA, vB, texture: edgeTexture[key] });
      }
    }

    if (boundaryEdges.length < 3) return;

    const adj = {};
    for (const edge of boundaryEdges) {
      if (!adj[edge.vA]) adj[edge.vA] = [];
      if (!adj[edge.vB]) adj[edge.vB] = [];
      adj[edge.vA].push({ to: edge.vB, key: edge.key });
      adj[edge.vB].push({ to: edge.vA, key: edge.key });
    }

    const usedEdges = new Set();
    const loops = [];

    for (const edge of boundaryEdges) {
      if (usedEdges.has(edge.key)) continue;
      const loop = [edge.vA];
      usedEdges.add(edge.key);
      let curr = edge.vB;
      let closed = false;

      while (true) {
        if (curr === loop[0]) {
          closed = true;
          break;
        }
        loop.push(curr);
        const neighbors = adj[curr] || [];
        const next = neighbors.find((n) => !usedEdges.has(n.key));
        if (!next) break;
        usedEdges.add(next.key);
        curr = next.to;
      }

      if (closed && loop.length >= 3) {
        loops.push({
          vertices: loop,
          texture: edge.texture ?? fallbackTexture ?? false,
        });
      }
    }

    if (loops.length === 0) return;

    // Outward normal of the cap faces toward the discarded side (-plane.normal)
    const nWorld = plane.normal.clone().negate().normalize();
    const ref =
      Math.abs(nWorld.x) < 0.9
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
    const uWorld = new THREE.Vector3().crossVectors(ref, nWorld).normalize();
    const vWorld = new THREE.Vector3().crossVectors(nWorld, uWorld).normalize();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.mesh.matrixWorld);

    const worldPos = new THREE.Vector3();
    const loopInfos = [];

    for (const loop of loops) {
      const pts2D = loop.vertices.map((vkey) => {
        worldPos.fromArray(mesh.vertices[vkey]);
        mesh.mesh.localToWorld(worldPos);
        return new THREE.Vector2(worldPos.dot(uWorld), worldPos.dot(vWorld));
      });
      const area = polygonSignedArea2D(pts2D);
      if (Math.abs(area) < 1e-8) continue;
      loopInfos.push({
        vertices: loop.vertices,
        pts2D,
        area,
        texture: loop.texture,
      });
    }

    if (loopInfos.length === 0) return;

    // Determine outer vs hole loops by containment depth
    for (let i = 0; i < loopInfos.length; i++) {
      let depth = 0;
      let parentIdx = -1;
      const samplePt = loopInfos[i].pts2D[0];
      for (let j = 0; j < loopInfos.length; j++) {
        if (i === j) continue;
        if (
          Math.abs(loopInfos[j].area) > Math.abs(loopInfos[i].area) &&
          pointInPolygon2D(samplePt, loopInfos[j].pts2D)
        ) {
          depth++;
          if (
            parentIdx === -1 ||
            Math.abs(loopInfos[j].area) < Math.abs(loopInfos[parentIdx].area)
          ) {
            parentIdx = j;
          }
        }
      }
      loopInfos[i].depth = depth;
      loopInfos[i].parentIdx = parentIdx;
      loopInfos[i].holes = [];
    }

    const outers = [];
    for (let i = 0; i < loopInfos.length; i++) {
      const info = loopInfos[i];
      if (info.depth % 2 === 0) {
        outers.push(info);
      } else if (info.parentIdx !== -1) {
        loopInfos[info.parentIdx].holes.push(info);
      }
    }

    const emitCapFace = (faceVertices, uvLookup, textureId) => {
      const unique = [];
      for (const vkey of faceVertices) {
        if (!unique.includes(vkey)) unique.push(vkey);
      }
      if (unique.length < 3) return;

      const capFace = new MeshFace(mesh, {
        vertices: unique,
        texture: textureId,
      });

      const localNorm = capFace.getNormal(true);
      const faceNormWorld = new THREE.Vector3(
        localNorm[0],
        localNorm[1],
        localNorm[2]
      )
        .applyMatrix3(normalMatrix)
        .normalize();
      if (faceNormWorld.dot(nWorld) < 0) {
        capFace.invert();
      }

      for (const vkey of capFace.vertices) {
        const uv = uvLookup[vkey];
        capFace.uv[vkey] = uv ? [uv[0], uv[1]] : [0, 0];
      }
      mesh.addFaces(capFace);
    };

    for (const outer of outers) {
      // Ensure outer contour is CCW in (uWorld, vWorld)
      if (outer.area < 0) {
        outer.vertices.reverse();
        outer.pts2D.reverse();
        outer.area = -outer.area;
      }

      // Compute planar UV mapping normalized to texture UV bounds
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (const p of outer.pts2D) {
        if (p.x < minU) minU = p.x;
        if (p.x > maxU) maxU = p.x;
        if (p.y < minV) minV = p.y;
        if (p.y > maxV) maxV = p.y;
      }

      const texObj = outer.texture
        ? Texture.all.find((t) => t.uuid === outer.texture)
        : null;
      const uvW =
        (texObj && typeof texObj.getUVWidth === "function"
          ? texObj.getUVWidth()
          : Project?.texture_width) || 16;
      const uvH =
        (texObj && typeof texObj.getUVHeight === "function"
          ? texObj.getUVHeight()
          : Project?.texture_height) || 16;

      const spanU = maxU - minU;
      const spanV = maxV - minV;
      const uvScale = Math.min(
        1,
        spanU > uvW ? uvW / spanU : 1,
        spanV > uvH ? uvH / spanV : 1
      );

      const uvLookup = {};
      const recordUVs = (verts, pts) => {
        for (let i = 0; i < verts.length; i++) {
          uvLookup[verts[i]] = [
            (pts[i].x - minU) * uvScale,
            (pts[i].y - minV) * uvScale,
          ];
        }
      };
      recordUVs(outer.vertices, outer.pts2D);

      if (
        outer.holes.length === 0 &&
        (outer.vertices.length === 3 ||
          (outer.vertices.length === 4 && isConvexCCW2D(outer.pts2D)))
      ) {
        emitCapFace(outer.vertices, uvLookup, outer.texture);
        continue;
      }

      const combinedVerts = outer.vertices.slice();
      const holes2D = [];
      for (const hole of outer.holes) {
        // Ensure holes are CW
        if (hole.area > 0) {
          hole.vertices.reverse();
          hole.pts2D.reverse();
          hole.area = -hole.area;
        }
        recordUVs(hole.vertices, hole.pts2D);
        combinedVerts.push(...hole.vertices);
        holes2D.push(hole.pts2D);
      }

      let tris = null;
      if (
        typeof THREE !== "undefined" &&
        THREE.ShapeUtils &&
        typeof THREE.ShapeUtils.triangulateShape === "function"
      ) {
        tris = THREE.ShapeUtils.triangulateShape(outer.pts2D, holes2D);
      } else {
        tris = earClipFallback(outer.pts2D);
      }

      for (const [i0, i1, i2] of tris) {
        emitCapFace(
          [combinedVerts[i0], combinedVerts[i1], combinedVerts[i2]],
          uvLookup,
          outer.texture
        );
      }
    }
  }

  /**
   * Remove any vertices in mesh no longer referenced by any face,
   * and prune deleted vertices from selection buffers.
   */
  function deleteOrphanVertices(mesh) {
    const used = new Set();
    for (const fkey in mesh.faces) {
      const face = mesh.faces[fkey];
      for (const vkey of face.vertices) {
        used.add(vkey);
      }
    }

    const removed = new Set();
    for (const vkey in mesh.vertices) {
      if (!used.has(vkey)) {
        delete mesh.vertices[vkey];
        removed.add(vkey);
      }
    }

    if (removed.size > 0) {
      const selVerts = mesh.getSelectedVertices(true);
      for (let i = selVerts.length - 1; i >= 0; i--) {
        if (removed.has(selVerts[i])) selVerts.splice(i, 1);
      }
      const selEdges = mesh.getSelectedEdges(true);
      for (let i = selEdges.length - 1; i >= 0; i--) {
        const edge = selEdges[i];
        if (removed.has(edge[0]) || removed.has(edge[1])) {
          selEdges.splice(i, 1);
        }
      }
    }
  }

  function runCut(plane) {
    if (!plane) return;

    const visibleMeshes = Mesh.all.filter(
      (m) => m.visibility && m.mesh && m.mesh.visible
    );
    if (visibleMeshes.length === 0) {
      Blockbench.showQuickMessage("No visible meshes to cut", 1500);
      return;
    }

    const worklist = [];
    for (const mesh of visibleMeshes) {
      const classification = classifyMeshFaces(mesh, plane);
      if (classification.straddling.length > 0 || classification.discard.length > 0) {
        worklist.push({ mesh, classification });
      }
    }

    if (worklist.length === 0) {
      Blockbench.showQuickMessage("Cut missed all visible meshes", 1200);
      return;
    }

    const affectedMeshes = worklist.map((item) => item.mesh);
    Undo.initEdit({ elements: affectedMeshes, selection: true });

    for (const { mesh, classification } of worklist) {
      const edgeCutCache = {};
      const deletedFaceSet = new Set();
      let fallbackTexture = false;

      for (const fkey of classification.straddling) {
        if (!fallbackTexture && mesh.faces[fkey]?.texture) {
          fallbackTexture = mesh.faces[fkey].texture;
        }
        cutFace(mesh, fkey, plane, classification.vertexDistances, edgeCutCache);
        deletedFaceSet.add(fkey);
      }

      if (!fallbackTexture) {
        for (const fkey of classification.keep) {
          if (mesh.faces[fkey]?.texture) {
            fallbackTexture = mesh.faces[fkey].texture;
            break;
          }
        }
      }

      for (const fkey of classification.discard) {
        delete mesh.faces[fkey];
        deletedFaceSet.add(fkey);
      }

      const selFaces = mesh.getSelectedFaces(true);
      for (let i = selFaces.length - 1; i >= 0; i--) {
        if (deletedFaceSet.has(selFaces[i])) selFaces.splice(i, 1);
      }

      capCutPlane(mesh, plane, classification.vertexDistances, fallbackTexture);
      deleteOrphanVertices(mesh);
    }

    Canvas.updateView({
      elements: affectedMeshes,
      element_aspects: { geometry: true, faces: true, uv: true },
      selection: true,
    });
    Undo.finishEdit("Zandatsu cut");
  }

  class ZandatsuContext {
    constructor() {
      this.angle = Math.PI / 2;
      this.pivotNdc = new THREE.Vector2(0, 0);
      this.pivotLocked = false;
      this.preview = Canvas.getHoveredPreview() || Preview.selected;

      this.group = new THREE.Group();
      this.group.name = "zandatsu_overlay";
      this.group.no_export = true;
      this.group.frustumCulled = false;

      // Cut line (2 vertices)
      this.lineGeo = new THREE.BufferGeometry();
      this.linePositions = new Float32Array(2 * 3);
      this.lineGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(this.linePositions, 3)
      );
      this.lineMat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      });
      this.line = new THREE.Line(this.lineGeo, this.lineMat);
      this.line.frustumCulled = false;
      this.line.renderOrder = 1000;

      // Red tinted discard half-plane quad (4 vertices, 2 triangles)
      this.quadGeo = new THREE.BufferGeometry();
      this.quadPositions = new Float32Array(4 * 3);
      this.quadGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(this.quadPositions, 3)
      );
      this.quadGeo.setIndex([0, 1, 2, 0, 2, 3]);
      this.quadMat = new THREE.MeshBasicMaterial({
        color: 0xff3333,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      });
      this.quad = new THREE.Mesh(this.quadGeo, this.quadMat);
      this.quad.frustumCulled = false;
      this.quad.renderOrder = 999;

      // Pivot marker (1 vertex, visible when pivot is locked)
      this.pivotGeo = new THREE.BufferGeometry();
      this.pivotPositions = new Float32Array(3);
      this.pivotGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(this.pivotPositions, 3)
      );
      this.pivotMat = new THREE.PointsMaterial({
        size: 9,
        sizeAttenuation: false,
        color: 0xffffff,
        depthTest: false,
        depthWrite: false,
      });
      this.pivotPoint = new THREE.Points(this.pivotGeo, this.pivotMat);
      this.pivotPoint.frustumCulled = false;
      this.pivotPoint.renderOrder = 1001;
      this.pivotPoint.visible = false;

      this.group.add(this.quad);
      this.group.add(this.line);
      this.group.add(this.pivotPoint);

      Canvas.scene.add(this.group);
      Canvas.gizmos.push(this.group);

      this._onCameraUpdate = (data) => {
        if (!data || !data.preview || data.preview === this.preview) {
          this.updateOverlay();
        }
      };
      this._onUnselectProject = () => {
        if (ZandatsuContext.current === this) {
          this.remove();
        }
      };
      this._pointerDown = null;
      this._onPointerUp = (event) => {
        if (!this._pointerDown) return;
        const down = this._pointerDown;
        this._pointerDown = null;

        if (event.button !== undefined && event.button !== 0) return;
        const dist = Math.hypot(event.clientX - down.x, event.clientY - down.y);
        if (dist > 6) return;

        this.handleStaticClick(event, down.preview);
      };
      Blockbench.on("update_camera_position", this._onCameraUpdate);
      Blockbench.on("unselect_project", this._onUnselectProject);
      document.addEventListener("pointerup", this._onPointerUp);

      this.updateOverlay();
    }

    _syncPreview() {
      const preview = Canvas.getHoveredPreview() || Preview.selected;
      if (preview) this.preview = preview;
      return this.preview;
    }

    hover(data) {
      const preview = this._syncPreview();
      const event = data && data.event ? data.event : null;

      if (!this.pivotLocked) {
        const cursor = screenCursorNdcFromEvent(event, preview);
        if (cursor) {
          this.pivotNdc.set(cursor.x, cursor.y);
        }
      } else {
        const nextAngle = screenAngleFromEvent(event, preview, this.pivotNdc);
        if (nextAngle !== null) {
          this.angle = nextAngle;
        }
      }

      this.updateOverlay();
    }

    click(data) {
      const preview = this._syncPreview();
      const event = data && data.event ? data.event : null;
      if (!event) return;
      if (event.button !== undefined && event.button !== 0) return;

      this._pointerDown = {
        x: event.clientX,
        y: event.clientY,
        preview,
      };
    }

    handleStaticClick(event, preview) {
      if (preview) this.preview = preview;
      const activePreview = this._syncPreview();

      if (!this.pivotLocked) {
        const cursor = screenCursorNdcFromEvent(event, activePreview);
        if (cursor) {
          this.pivotNdc.set(cursor.x, cursor.y);
        }
        this.pivotLocked = true;
        this.pivotPoint.visible = true;
        this.updateOverlay();
        return;
      }

      const plane = buildCutPlane(this.angle, activePreview, this.pivotNdc);
      runCut(plane);
      this.unlockPivot({ event });
    }

    unlockPivot(data) {
      this.pivotLocked = false;
      this.pivotPoint.visible = false;
      const preview = this._syncPreview();
      const event = data && data.event ? data.event : null;
      const cursor = screenCursorNdcFromEvent(event, preview);
      if (cursor) {
        this.pivotNdc.set(cursor.x, cursor.y);
      }
      this.updateOverlay();
    }

    updateOverlay() {
      const preview = this.preview || Preview.selected;
      if (!preview || !preview.camera || !preview.width || !preview.height) {
        return;
      }

      preview.camera.updateMatrixWorld();

      const halfW = preview.width / 2;
      const halfH = preview.height / 2;
      const span = Math.hypot(preview.width, preview.height) * 2;

      const cos = Math.cos(this.angle);
      const sin = Math.sin(this.angle);

      // Along the cut line in NDC
      const dx = (cos * span) / halfW;
      const dy = (sin * span) / halfH;

      // Perpendicular to the cut line toward the discard side in NDC
      const sideSign = getDiscardSign();
      const lx = (-sin * sideSign * span) / halfW;
      const ly = (cos * sideSign * span) / halfH;

      const px = this.pivotNdc.x;
      const py = this.pivotNdc.y;
      const ndcZ = 0;

      const pPivot = new THREE.Vector3(px, py, ndcZ).unproject(preview.camera);
      const pA = new THREE.Vector3(px - dx, py - dy, ndcZ).unproject(preview.camera);
      const pB = new THREE.Vector3(px + dx, py + dy, ndcZ).unproject(preview.camera);
      const pBL = new THREE.Vector3(px + dx + lx, py + dy + ly, ndcZ).unproject(preview.camera);
      const pAL = new THREE.Vector3(px - dx + lx, py - dy + ly, ndcZ).unproject(preview.camera);

      this.pivotPositions[0] = pPivot.x;
      this.pivotPositions[1] = pPivot.y;
      this.pivotPositions[2] = pPivot.z;
      this.pivotGeo.attributes.position.needsUpdate = true;

      this.linePositions[0] = pA.x;
      this.linePositions[1] = pA.y;
      this.linePositions[2] = pA.z;
      this.linePositions[3] = pB.x;
      this.linePositions[4] = pB.y;
      this.linePositions[5] = pB.z;
      this.lineGeo.attributes.position.needsUpdate = true;

      this.quadPositions[0] = pA.x;
      this.quadPositions[1] = pA.y;
      this.quadPositions[2] = pA.z;
      this.quadPositions[3] = pB.x;
      this.quadPositions[4] = pB.y;
      this.quadPositions[5] = pB.z;
      this.quadPositions[6] = pBL.x;
      this.quadPositions[7] = pBL.y;
      this.quadPositions[8] = pBL.z;
      this.quadPositions[9] = pAL.x;
      this.quadPositions[10] = pAL.y;
      this.quadPositions[11] = pAL.z;
      this.quadGeo.attributes.position.needsUpdate = true;
    }

    cancel() {
      this.remove();
    }

    remove() {
      if (this._onCameraUpdate) {
        Blockbench.removeListener("update_camera_position", this._onCameraUpdate);
        this._onCameraUpdate = null;
      }
      if (this._onUnselectProject) {
        Blockbench.removeListener("unselect_project", this._onUnselectProject);
        this._onUnselectProject = null;
      }
      if (this._onPointerUp) {
        document.removeEventListener("pointerup", this._onPointerUp);
        this._onPointerUp = null;
      }
      this._pointerDown = null;
      if (this.group) {
        Canvas.scene.remove(this.group);
        const idx = Canvas.gizmos.indexOf(this.group);
        if (idx !== -1) Canvas.gizmos.splice(idx, 1);
      }
      this.lineGeo?.dispose();
      this.lineMat?.dispose();
      this.quadGeo?.dispose();
      this.quadMat?.dispose();
      this.pivotGeo?.dispose();
      this.pivotMat?.dispose();
      if (ZandatsuContext.current === this) {
        ZandatsuContext.current = null;
      }
    }
  }
  ZandatsuContext.current = null;

  Plugin.register("zandatsu", {
    title: "Zandatsu",
    author: "Luther Gray",
    icon: "fa-slash",
    description:
      "Adds a single tool that can cut through a mesh.",
    version: "1.0.2",
    variant: "both",

    onload() {
      discardSideSelect = new BarSelect("zandatsu_discard_side", {
        name: "Discard Side",
        description: "Choose which side of the cut line is removed",
        category: "tools",
        condition: () => Modes.edit && Mesh.hasAny(),
        options: {
          left: "Discard Left",
          right: "Discard Right",
        },
        value: "left",
        onChange() {
          if (ZandatsuContext.current) {
            ZandatsuContext.current.updateOverlay();
          }
        },
      });

      zandatsuToolbar = new Toolbar("zandatsu", {
        children: ["zandatsu_discard_side"],
      });

      zandatsuTool = new Tool("zandatsu", {
        name: "Zandatsu",
        description: "Slice through meshes along a screen-space plane",
        icon: "fa-slash",
        transformerMode: "hidden",
        toolbar: "zandatsu",
        category: "tools",
        selectElements: false,
        cursor: "crosshair",
        modes: ["edit"],
        condition: () => Modes.edit && Mesh.hasAny(),
        onCanvasMouseMove(data) {
          if (!ZandatsuContext.current) {
            ZandatsuContext.current = new ZandatsuContext();
          }
          ZandatsuContext.current.hover(data);
        },
        onCanvasClick(data) {
          if (!ZandatsuContext.current) {
            ZandatsuContext.current = new ZandatsuContext();
          }
          ZandatsuContext.current.click(data);
        },
        onCanvasRightClick(data) {
          if (ZandatsuContext.current && ZandatsuContext.current.pivotLocked) {
            ZandatsuContext.current.unlockPivot(data);
            return false;
          }
        },
        onSelect() {
          if (!ZandatsuContext.current) {
            ZandatsuContext.current = new ZandatsuContext();
          }
        },
        onUnselect() {
          if (ZandatsuContext.current) {
            ZandatsuContext.current.remove();
          }
        },
      });

      Toolbars.tools.add(zandatsuTool);
    },

    onunload() {
      if (ZandatsuContext.current) {
        ZandatsuContext.current.remove();
      }
      if (zandatsuTool) {
        if (typeof Toolbox !== "undefined" && Toolbox.selected === zandatsuTool) {
          BarItems.move_tool?.select();
        }
        zandatsuTool.delete();
        zandatsuTool = null;
      }
      if (zandatsuToolbar) {
        if (zandatsuToolbar.node && zandatsuToolbar.node.parentElement) {
          zandatsuToolbar.node.remove();
        }
        if (typeof Toolbars !== "undefined" && Toolbars.zandatsu === zandatsuToolbar) {
          delete Toolbars.zandatsu;
        }
        zandatsuToolbar = null;
      }
      if (discardSideSelect) {
        discardSideSelect.delete();
        discardSideSelect = null;
      }
    },
  });
})();
