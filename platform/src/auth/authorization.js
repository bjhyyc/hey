const USER_ROLES = Object.freeze({ USER: "user", ADMIN: "admin" });

function requireActor(actor) {
  if (!actor || typeof actor.id !== "string" || !actor.id) {
    throw new Error("Authenticated actor is required");
  }
  if (!Object.values(USER_ROLES).includes(actor.role)) {
    throw new Error("Actor has an unsupported role");
  }
  return actor;
}

function requireAdmin(actor) {
  const authenticated = requireActor(actor);
  if (authenticated.role !== USER_ROLES.ADMIN) throw new Error("Administrator role is required");
  return authenticated;
}

function requireProjectOwner(actor, project) {
  const authenticated = requireActor(actor);
  if (!project || typeof project.userId !== "string") throw new Error("Project is required");
  if (authenticated.role !== USER_ROLES.ADMIN && project.userId !== authenticated.id) {
    throw new Error("Project access is denied");
  }
  return project;
}

module.exports = {
  USER_ROLES,
  requireActor,
  requireAdmin,
  requireProjectOwner
};
