import { reportRoutes } from '../src/report.mjs';

// Thin wrapper: the logic lives in src/report.mjs so the executable can expose
// the same report through --routes.
reportRoutes();
