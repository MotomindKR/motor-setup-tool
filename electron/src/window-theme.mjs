// Native caption buttons sit above the web page, so its modal backdrops cannot
// shade them. Composite those same backdrops over the caption palette.
export function syncWindowTheme(bridge, choice, theme) {
  if (!bridge?.setWindowTheme) return () => {};
  if (bridge.platform === "darwin") {
    bridge.setWindowTheme(choice).catch(() => {});
    return () => {};
  }
  const selector = '[data-slot="dialog-overlay"], [data-slot="sheet-overlay"]';
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let frame = null;
  let previous;
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(sync);
  };
  const hex = (pixels, offset) =>
    "#" +
    [...pixels.slice(offset, offset + 3)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  function sync() {
    frame = null;
    context.globalAlpha = 1;
    context.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = theme === "dark" ? "#fafafa" : "#171717";
    context.fillRect(1, 0, 1, 1);
    let animating = false;
    for (const backdrop of document.querySelectorAll(selector)) {
      const style = getComputedStyle(backdrop);
      if (style.display === "none" || style.visibility === "hidden") continue;
      context.globalAlpha = Number(style.opacity);
      context.fillStyle = style.backgroundColor;
      context.fillRect(0, 0, 2, 1);
      animating ||= backdrop
        .getAnimations()
        .some((animation) => animation.playState === "running");
    }
    const pixels = context.getImageData(0, 0, 2, 1).data;
    const caption = { color: hex(pixels, 0), symbolColor: hex(pixels, 4) };
    const key = caption.color + caption.symbolColor;
    if (key !== previous) {
      previous = key;
      bridge.setWindowTheme(choice, caption).catch(() => {});
    }
    if (animating) schedule();
  }
  const containsBackdrop = (node) =>
    node.nodeType === 1 &&
    (node.matches(selector) || node.querySelector(selector));
  const observer = new MutationObserver((records) => {
    if (
      records.some((record) =>
        record.type === "attributes"
          ? record.target.matches(selector)
          : [...record.addedNodes, ...record.removedNodes].some(
              containsBackdrop,
            ),
      )
    )
      schedule();
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      "data-open",
      "data-closed",
      "data-starting-style",
      "data-ending-style",
    ],
  });
  schedule();
  return () => {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
