// Side-effect import: load the root .env before any other module reads process.env.
import { loadEnv } from "./env";

loadEnv();
