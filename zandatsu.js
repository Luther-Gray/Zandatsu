(function () {
  let zandatsuTool = null;

  /**
   * Compute the screen-space angle (in radians) from the pivot to the cursor.
   * Falls back to preview.mouse (NDC) when event is unavailable (e.g. raycast miss).
   */
  function screenAngleFromEvent(event, preview, pivotNdc) {
    if (!preview) return null;
    const pivotX = pivotNdc ? pivotNdc.x : 0;
    const pivotY = pivotNdc ? pivotNdc.y : 0;

    let mx;
    let my;
    if (event && typeof event.clientX === "number" && preview.canvas) {
      const rect = preview.canvas.getBoundingClientRect();
      mx = ((event.clientX - rect.left) / preview.width) * 2 - 1;
      my = -((event.clientY - rect.top) / preview.height) * 2 + 1;
    } else if (preview.mouse) {
      mx = preview.mouse.x;
      my = preview.mouse.y;
    } else {
      return null;
    }

    const dx = (mx - pivotX) * (preview.width / 2);
    const dy = (my - pivotY) * (preview.height / 2);
    if (dx === 0 && dy === 0) return null;
    return Math.atan2(dy, dx);
  }

  class ZandatsuContext {
    constructor() {
      this.angle = Math.PI / 2;
      this.pivotNdc = new THREE.Vector2(0, 0);
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

      this.group.add(this.quad);
      this.group.add(this.line);

      Canvas.scene.add(this.group);
      Canvas.gizmos.push(this.group);

      this._onCameraUpdate = (data) => {
        if (!data || !data.preview || data.preview === this.preview) {
          this.updateOverlay();
        }
      };
      Blockbench.on("update_camera_position", this._onCameraUpdate);

      this.updateOverlay();
    }

    hover(data) {
      const preview = Canvas.getHoveredPreview() || Preview.selected;
      if (preview) this.preview = preview;

      const event = data && data.event ? data.event : null;
      const nextAngle = screenAngleFromEvent(event, this.preview, this.pivotNdc);
      if (nextAngle !== null) {
        this.angle = nextAngle;
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

      const pA = new THREE.Vector3(px - dx, py - dy, ndcZ).unproject(preview.camera);
      const pB = new THREE.Vector3(px + dx, py + dy, ndcZ).unproject(preview.camera);
      const pBL = new THREE.Vector3(px + dx + lx, py + dy + ly, ndcZ).unproject(preview.camera);
      const pAL = new THREE.Vector3(px - dx + lx, py - dy + ly, ndcZ).unproject(preview.camera);

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
      if (this.group) {
        Canvas.scene.remove(this.group);
        const idx = Canvas.gizmos.indexOf(this.group);
        if (idx !== -1) Canvas.gizmos.splice(idx, 1);
      }
      this.lineGeo?.dispose();
      this.lineMat?.dispose();
      this.quadGeo?.dispose();
      this.quadMat?.dispose();
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
          console.log("[Zandatsu] onCanvasClick:", data);
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
