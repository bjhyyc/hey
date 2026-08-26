/**
 * Local launcher for the console trial harness. The harness refuses to start
 * when real credentials are present in the environment - correct on a server,
 * but a developer's own machine legitimately carries operational variables
 * from other work. Rather than weakening that guard with a bypass flag, this
 * launcher strips every real-credential variable before starting: the guard's
 * property still holds because the credentials genuinely do not exist inside
 * the harness process.
 */

const STRIPPED_PREFIXES = [
  "PETPACK_POSTGRES",
  "PETPACK_KAIPAY",
  "PETPACK_COS",
  "PETPACK_STUDIO_INTERNAL",
  "MODELARK_",
  "PETPACK_PAYMENT"
];

for (const name of Object.keys(process.env)) {
  if (STRIPPED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    delete process.env[name];
  }
}
delete process.env.PETPACK_PLATFORM_MODE;

require("./start-admin-console-fixture")
  .main()
  .catch((error) => {
    process.stderr.write(`admin console fixture failed: ${error && error.message ? error.message : error}\n`);
    process.exit(1);
  });
