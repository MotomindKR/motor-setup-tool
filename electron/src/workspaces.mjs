export const workspaces = {
  robstride: {
    label: "RobStride",
    pages: {
      calibrate: { label: "Calibrate", title: "Calibration", showConnection: true },
      test: { label: "Test", title: "Motor test", showConnection: true },
      setup: { label: "Setup", title: "Motor setup", showConnection: true },
      files: { label: "Files", title: "Recordings" },
    },
  },
  dynamixel: {
    label: "Dynamixel",
    pages: {
      dxl: { title: "Dynamixel setup", breadcrumb: "Motor setup" },
    },
  },
  camera: {
    label: "Camera",
    pages: {
      camera: { title: "Camera verification", breadcrumb: "Focus check" },
    },
  },
};

export const workspaceByPage = new Map(
  Object.entries(workspaces).flatMap(([workspace, { pages }]) =>
    Object.keys(pages).map((page) => [page, workspace]),
  ),
);
