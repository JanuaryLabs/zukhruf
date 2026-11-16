// An engine id names one container engine in a run: docker, docker-vmm,
// colima, orbstack, apple. Each caller anchors it for its own match.
export const engineId = '[a-z][a-z0-9-]*';
