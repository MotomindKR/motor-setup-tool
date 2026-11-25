import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { unzipSync } from "fflate";
import {
  AmbientLight, Box3, DirectionalLight, Euler, GridHelper, Group, Mesh,
  MeshStandardMaterial, PerspectiveCamera, Scene, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import description from "../../../assets/milly/MILLY.urdf?raw";
import archive from "../../../assets/milly/meshes.zip?url&inline";
import { gripperFingerTravel } from "../teaching-pose.mjs";
import { Button } from "../ui.jsx";

function vector(element, name, fallback = [0, 0, 0]) {
  const value = element?.getAttribute(name);
  return value ? value.trim().split(/\s+/).map(Number) : fallback;
}

function origin(node) {
  const frame = new Group();
  const element = node.querySelector("origin");
  frame.position.fromArray(vector(element, "xyz"));
  frame.quaternion.setFromEuler(new Euler(...vector(element, "rpy"), "ZYX"));
  return frame;
}

function loadMilly() {
  const robot = new DOMParser().parseFromString(description, "application/xml");
  const meshes = unzipSync(Uint8Array.fromBase64(archive.slice(archive.indexOf(",") + 1)));
  const loader = new STLLoader();
  const links = new Map();
  const joints = new Map();
  const body = new MeshStandardMaterial({ color: 0xc6ceda, metalness: 0.25, roughness: 0.57 });
  const fingers = new MeshStandardMaterial({ color: 0x475569, roughness: 0.63 });
  for (const element of robot.querySelectorAll("robot > link")) {
    const name = element.getAttribute("name");
    const link = new Group();
    links.set(name, link);
    for (const visual of element.querySelectorAll("visual")) {
      const reference = visual.querySelector("geometry > mesh");
      const meshName = reference.getAttribute("filename").split("/").at(-1);
      const bytes = meshes[meshName];
      const mesh = new Mesh(loader.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
        name.startsWith("finger_") ? fingers : body);
      mesh.scale.fromArray(vector(reference, "scale", [1, 1, 1]));
      const frame = origin(visual);
      frame.add(mesh);
      link.add(frame);
    }
  }
  for (const element of robot.querySelectorAll("robot > joint")) {
    const frame = origin(element);
    const motion = new Group();
    frame.add(motion);
    motion.add(links.get(element.querySelector("child").getAttribute("link")));
    links.get(element.querySelector("parent").getAttribute("link")).add(frame);
    joints.set(element.getAttribute("name"), {
      motion,
      axis: new Vector3(...vector(element.querySelector("axis"), "xyz")).normalize(),
    });
  }
  return { root: links.get("base_link"), joints, materials: [body, fingers] };
}

function applyPose(joints, pose) {
  for (const { name, position } of pose ?? []) {
    if (name === "gripper") {
      for (const finger of ["finger_1_joint", "finger_2_joint"]) {
        const { motion, axis } = joints.get(finger);
        motion.position.copy(axis).multiplyScalar(gripperFingerTravel(position));
      }
    } else {
      const { motion, axis } = joints.get(name);
      motion.quaternion.setFromAxisAngle(axis, position);
    }
  }
}

export function MillyViewer({ pose }) {
  const { t } = useTranslation();
  const host = useRef(null);
  const viewport = useRef(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const element = host.current;
    let renderer;
    let robot;
    let grid;
    let controls;
    let resize;
    function dispose() {
      resize?.disconnect();
      controls?.dispose();
      robot?.root.traverse((node) => node.geometry?.dispose());
      robot?.materials.forEach((material) => material.dispose());
      grid?.geometry.dispose();
      grid?.material.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer?.domElement.remove();
      viewport.current = null;
    }
    try {
      renderer = new WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      element.append(renderer.domElement);
      robot = loadMilly();
      applyPose(robot.joints, [{ name: "gripper", position: 0 }]);
      const scene = new Scene();
      scene.add(robot.root, new AmbientLight(0xe2e8f0, 2.1));
      const light = new DirectionalLight(0xffffff, 3);
      light.position.set(1, -2, 3);
      scene.add(light);
      grid = new GridHelper(1.6, 16, 0x64748b, 0x94a3b8);
      grid.rotateX(Math.PI / 2);
      grid.position.z = -0.002;
      grid.material.transparent = true;
      grid.material.opacity = 0.55;
      scene.add(grid);
      const camera = new PerspectiveCamera(40, 1, 0.025, 10);
      camera.up.set(0, 0, 1);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.minDistance = 0.25;
      controls.maxDistance = 5;
      const bounds = new Box3().setFromObject(robot.root);
      const target = bounds.getCenter(new Vector3());
      const view = new Vector3(0.72, -1.05, 0.65);
      function draw() { renderer.render(scene, camera); }
      function resetView() {
        controls.target.copy(target);
        camera.position.copy(target).add(view);
        controls.update();
        draw();
      }
      controls.addEventListener("change", draw);
      resetView();
      resize = new ResizeObserver(() => {
        const { clientWidth: width, clientHeight: height } = element;
        if (!width || !height) return;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
        draw();
      });
      resize.observe(element);
      viewport.current = { draw, resetView, joints: robot.joints };
    } catch (problem) {
      console.error("Milly viewer:", problem);
      dispose();
      setError(true);
      return undefined;
    }
    return dispose;
  }, []);

  useEffect(() => {
    if (!viewport.current) return;
    applyPose(viewport.current.joints, pose);
    viewport.current.draw();
  }, [pose]);

  return (
    <div className="milly-viewport">
      <div className="milly-canvas" ref={host} role="img" aria-label={t("3D model of MILLY")} />
      {error ? <p role="alert">{t("The 3D view could not start. Check graphics acceleration.")}</p> :
        <Button className="milly-reset" size="sm" variant="outline" onClick={() => viewport.current?.resetView()}>
          {t("Reset view")}
        </Button>}
    </div>
  );
}
