import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@motomindkr/ui/components/alert";
import { Badge } from "@motomindkr/ui/components/badge";
import { Button, Choice, Field, Panel } from "../ui.jsx";

const defaultCamera = "system-default";

function cameraError(error) {
  switch (error.name) {
    case "NotAllowedError":
      return "Allow camera access in your system privacy settings and try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Camera not found. Connect a USB camera and refresh the list.";
    case "NotReadableError":
      return "Camera could not start. Close other apps using it and try again.";
    default:
      return "Camera preview could not start.";
  }
}

async function videoDevices(media) {
  return (await media.enumerateDevices()).filter(({ kind, deviceId }) =>
    kind === "videoinput" && deviceId);
}

export function CameraPage() {
  const { t } = useTranslation();
  const media = navigator.mediaDevices;
  const video = useRef(null);
  const stream = useRef(null);
  const generation = useRef(0);
  const [devices, setDevices] = useState([]);
  const [selected, setSelected] = useState(defaultCamera);
  const [phase, setPhase] = useState("off");
  const [resolution, setResolution] = useState("");
  const [error, setError] = useState("");

  function release() {
    const previous = stream.current;
    stream.current = null;
    previous?.getTracks().forEach((track) => track.stop());
    if (video.current) video.current.srcObject = null;
  }

  function stop() {
    generation.current += 1;
    release();
    setPhase("off");
    setResolution("");
  }

  async function refreshDevices() {
    const request = generation.current;
    try {
      const available = await videoDevices(media);
      if (request !== generation.current) return;
      setDevices(available);
      setSelected((id) => available.some((device) => device.deviceId === id) ? id : defaultCamera);
    } catch {
      if (request === generation.current) setError("Camera list could not be refreshed.");
    }
  }

  useEffect(() => {
    if (!media) return;
    void refreshDevices();
    const onVisibility = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", onVisibility);
    media.addEventListener("devicechange", refreshDevices);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      media.removeEventListener("devicechange", refreshDevices);
      generation.current += 1;
      release();
    };
  }, [media]);

  async function start(id) {
    const request = ++generation.current;
    release();
    setPhase("starting");
    setError("");
    setResolution("");
    try {
      const allowed = await window.motorApp?.authorizeCamera?.();
      if (request !== generation.current) return;
      if (allowed === false) throw new DOMException("", "NotAllowedError");
      const next = await media.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
          resizeMode: { ideal: "none" },
          ...(id === defaultCamera ? {} : { deviceId: { exact: id } }),
        },
      });
      if (request !== generation.current) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = next;
      const track = next.getVideoTracks()[0];
      track.addEventListener("ended", () => {
        if (stream.current !== next) return;
        stop();
        setError("Camera disconnected. Refresh the list to reconnect.");
      }, { once: true });
      video.current.srcObject = next;
      setPhase("live");
      const available = await videoDevices(media).catch(() => undefined);
      if (request !== generation.current || !available) return;
      setDevices(available);
      const activeId = track.getSettings().deviceId;
      if (available.some((device) => device.deviceId === activeId)) setSelected(activeId);
    } catch (problem) {
      if (request !== generation.current) return;
      release();
      setPhase("off");
      setError(cameraError(problem));
    }
  }

  const options = [
    { value: defaultCamera, label: t("Default camera") },
    ...devices.map((device, index) => ({
      value: device.deviceId,
      label: device.label || t("Camera {{number}}", { number: index + 1 }),
    })),
  ];
  return (
    <Panel
      title={t("Camera focus check")}
      description={t("Select a USB camera and check focus in the live image.")}
      action={<Badge variant={phase === "live" ? "success" : "secondary"} role="status">
        {phase === "live" ? t("Live") : phase === "starting" ? t("Starting camera…") : t("Preview off")}
      </Badge>}
    >
      <div className="camera-controls">
        <Field label={t("Camera device")}>
          <Choice
            value={selected}
            options={options}
            disabled={!media || phase === "starting"}
            onChange={(id) => {
              setSelected(id);
              if (phase === "live") void start(id);
            }}
          />
        </Field>
        <Button variant="outline" disabled={!media || phase === "starting"} onClick={() => void refreshDevices()}>
          {t("Refresh cameras")}
        </Button>
        {phase !== "off" ? (
          <Button variant="outline" onClick={stop}>{t("Stop preview")}</Button>
        ) : (
          <Button disabled={!media} onClick={() => void start(selected)}>{t("Start preview")}</Button>
        )}
      </div>
      {(!media || error) && (
        <Alert variant="error" role="alert">
          <AlertDescription>{t(error || "Camera access is unavailable.")}</AlertDescription>
        </Alert>
      )}
      <div className="camera-image">
        <video
          ref={video}
          autoPlay
          muted
          playsInline
          aria-label={t("Live camera image")}
          onResize={(event) => {
            const { videoWidth, videoHeight } = event.currentTarget;
            setResolution(videoWidth && videoHeight ? `${videoWidth} × ${videoHeight}` : "");
          }}
        />
        {phase !== "live" && <p>{t("Start a preview to see the camera image.")}</p>}
      </div>
      {phase === "live" && resolution && <p className="verification-caption">
        {t("Received video · {{resolution}}", { resolution })}
      </p>}
    </Panel>
  );
}
