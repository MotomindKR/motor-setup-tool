import profile from "../../assets/milly/teaching-profile.json" with { type: "json" };

export const teachingIds = profile.ids;

export function teachingDevicesMatch(motors) {
  const byId = new Map(motors.map((motor) => [motor.motor_id, motor.name]));
  return teachingIds.every((id, index) => byId.get(id) === profile.models[index]);
}

export function mapTeachingPose(raw) {
  if (!Array.isArray(raw) || raw.length !== teachingIds.length || !raw.every(Number.isFinite)) {
    throw new Error("Incomplete teaching position sample.");
  }
  return profile.joint_names.map((name, index) => {
    const mapped = (raw[index] - profile.position_offset_rad[index]) * profile.position_gain[index];
    const [min, max] = profile.position_limits_rad[index];
    const position = Math.max(min, Math.min(max, mapped));
    return { name, id: teachingIds[index], position, measured: mapped, limited: position !== mapped };
  });
}

export function gripperFingerTravel(position) {
  return 0.05 * (1 - Math.max(0, Math.min(1, position / 2.11)));
}
