import { defineRailway, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const web = service("web", {
    build: "npm run build",
    start: "npm start",
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    // Restarts on failure (Railway's default policy), up to 5 times.
    deploy: {
      restartPolicyMaxRetries: 5,
    },
    env: {
      // SQLite database and per-sheet JSON files live on the volume.
      DATA_DIR: "/data",
      // Railway serves over HTTPS, so session cookies can be Secure.
      SECURE_COOKIES: "1",
    },
    volumeMounts: {
      "/data": volume("flow-sheets-data", { region: "sfo", sizeMB: 5000 }),
    },
    domains: ["sheets.freeflow.im"],
    // A volume can only be attached to a single replica.
    replicas: { sfo: 1 },
  });

  return project("flow-sheets", {
    resources: [web],
  });
});
