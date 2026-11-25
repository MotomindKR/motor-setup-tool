import assert from "node:assert/strict";
import { test } from "node:test";
import { gripperFingerTravel, mapTeachingPose, teachingDevicesMatch, teachingIds } from "./teaching-pose.mjs";

test("teaching model uses SDK IDs, offsets, gripper gain, and per-joint limits", () => {
  const raw = [0.25, -0.5, 0.7, 0, -0.25, 2, 0.5].map((value) => value + Math.PI);
  const pose = mapTeachingPose(raw);
  assert.deepEqual(pose.map(({ id }) => id), teachingIds);
  assert.deepEqual(pose.map(({ position }) => position), [0.25, -0.5, 0, 0, -0.25, 1.55, 1.5]);
  assert.deepEqual(pose.filter(({ limited }) => limited).map(({ name }) => name), ["joint_3", "joint_6"]);
  assert.equal(gripperFingerTravel(0), 0.05);
  assert.equal(gripperFingerTravel(2.11), 0);
  assert.throws(() => mapTeachingPose(raw.slice(1)), /Incomplete/);
  assert.throws(() => mapTeachingPose(raw.fill(NaN)), /Incomplete/);
});

test("checks the axis IDs and hardware models even when discovery order differs", () => {
  const axes = teachingIds.map((motor_id, index) => ({
    motor_id, name: index === 6 ? "XL330-M077-T" : "XL330-M288-T",
  })).reverse();
  assert.ok(teachingDevicesMatch(axes));
  assert.ok(!teachingDevicesMatch(axes.slice(1)));
  assert.ok(!teachingDevicesMatch([{ ...axes[0], name: "XL330-M288-T" }, ...axes.slice(1)]));
});
