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
  // Someone else's project is reported exactly like one that does not
  // exist. Telling them apart (400 for unknown, 403 for another owner's)
  // answered "does this id exist?" to anyone who had picked one up.
  if (!project || typeof project.userId !== "string") throw new Error("Project was not found");
  if (authenticated.role !== USER_ROLES.ADMIN && project.userId !== authenticated.id) {
    throw new Error("Project was not found");
  }
  return project;
}

module.exports = {
  USER_ROLES,
  requireActor,
  requireAdmin,
  requireProjectOwner
};
