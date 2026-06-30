// Pure projection of a task onto the fields `lander list` needs to triage a
// task — id, title, status, and its created/updated timestamps — without the
// conversation. Split out from bin/lander so it's importable by a test
// without tripping the script's top-level command dispatch.
export function taskMetadata(t) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(t.scheduledFor ? { scheduledFor: t.scheduledFor } : {}),
  }
}
