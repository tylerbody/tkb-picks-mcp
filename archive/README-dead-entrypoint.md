# archive/index-v2.5.3-DEAD-ENTRYPOINT.ts

The pre-refactor single-file entry point, moved here 2026-09-24. It is NOT built and
NOT run: `tsconfig.json` sets `rootDir: ./src`, `package.json` main is `dist/index.js`
which comes from `src/index.ts`, and `npm start` / `npm run dev` both point at src.

It carried `SERVER_VERSION = "2.5.3"` against the live 2.10.x, which is exactly the
drift `src/index.ts` warns about where it explains why the version string is declared
once. A file that looks like the entry point and is five releases stale is a debugging
session waiting to happen, so it is out of the repo root and labelled.

Kept rather than deleted only because it is the last readable snapshot of the
pre-refactor shape. Do not edit it; nothing reads it.
