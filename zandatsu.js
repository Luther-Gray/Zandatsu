(function () {
  let zandatsuTool = null;

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
          console.log("[Zandatsu] onCanvasMouseMove:", data);
        },
        onCanvasClick(data) {
          console.log("[Zandatsu] onCanvasClick:", data);
        },
        onSelect() {},
        onUnselect() {
          // Overlay cleanup will be wired here in Phase 2.
        },
      });

      Toolbars.tools.add(zandatsuTool);
    },

    onunload() {
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
