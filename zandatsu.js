(function () {
  let zandatsuTool = null;

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

    // Left of the cut line (discard side)
    const lx = (-sin * step) / halfW;
    const ly = (cos * step) / halfH;

    const px = pivotNdc ? pivotNdc.x : 0;
    const py = pivotNdc ? pivotNdc.y : 0;

    const p0 = new THREE.Vector3(px, py, 0).unproject(preview.camera);
    const p1 = new THREE.Vector3(px + dx, py + dy, 0).unproject(preview.camera);
    const p2 = new THREE.Vector3(px, py, 0.5).unproject(preview.camera);
    const pLeft = new THREE.Vector3(px + lx, py + ly, 0).unproject(preview.camera);

    const plane = new THREE.Plane().setFromCoplanarPoints(p0, p1, p2);
    if (plane.distanceToPoint(pLeft) > 0) {
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

    return { keep, discard, straddling };
  }

  function classifyVisibleMeshes(plane) {
    const results = {};
    for (const mesh of Mesh.all) {
      if (!mesh.visibility || !mesh.mesh || !mesh.mesh.visible) continue;
      results[mesh.name || mesh.uuid] = classifyMeshFaces(mesh, plane);
    }
    return results;
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
      Blockbench.on("update_camera_position", this._onCameraUpdate);
      Blockbench.on("unselect_project", this._onUnselectProject);

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

      const plane = buildCutPlane(this.angle, preview, this.pivotNdc);
      if (plane) {
        console.log("[Zandatsu] Face classification:", classifyVisibleMeshes(plane));
      }
    }

    click(data) {
      const preview = this._syncPreview();
      const event = data && data.event ? data.event : null;

      if (!this.pivotLocked) {
        const cursor = screenCursorNdcFromEvent(event, preview);
        if (cursor) {
          this.pivotNdc.set(cursor.x, cursor.y);
        }
        this.pivotLocked = true;
        this.pivotPoint.visible = true;
        this.updateOverlay();
        return;
      }

      // Second click confirms the cut (mesh cutting added in Phase 4).
      const plane = buildCutPlane(this.angle, preview, this.pivotNdc);
      console.log("[Zandatsu] Cut confirmed:", {
        pivotNdc: { x: this.pivotNdc.x, y: this.pivotNdc.y },
        angle: this.angle,
        classification: plane ? classifyVisibleMeshes(plane) : null,
      });
      this.unlockPivot(data);
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

      // Perpendicular to the left of the cut line (discard side) in NDC
      const lx = (-sin * span) / halfW;
      const ly = (cos * span) / halfH;

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
    version: "0.0.1",
    variant: "both",

    onload() {
      zandatsuTool = new Tool("zandatsu", {
        name: "Zandatsu",
        description: "Slice through meshes along a screen-space plane",
        icon: "fa-slash",
        transformerMode: "hidden",
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
    },
  });
})();
