See CLAUDE.md.

When adding or changing code that mutates user documents, invalidate the auth user document cache for affected users. This includes single-user updates and bulk role/user mutations; otherwise OpenID JWT request burst caching can serve a stale `req.user` until its TTL expires.

## Cursor Cloud specific instructions

- Use Node.js **v24.16.0** (`.nvmrc`, npm 11.13.0). The image default is older; `node -v` must print `v24.16.0` before `npm ci` or `npm run smart-reinstall`.
- MongoDB is not started by any npm script. `mongod` is at `/usr/local/bin/mongod` (8.0 tarball under `/opt/mongodb`). Data directory: `$HOME/mongodb-data`, port `27017`, bind `127.0.0.1`.
- If `.env` is missing, copy `.env.example`. Set `SEARCH=false` unless Meilisearch is actually running. `HOST=localhost` makes the API listen on IPv6 localhost; use `http://localhost:3080`, not `http://127.0.0.1:3080`.
- `npm run smart-reinstall -- --skip-client` installs dependencies and builds the workspace packages. The API still reads `client/dist/index.html` at boot. Copy `client/index.html` there when the production client bundle has not been built. The dev UI is Vite: `npm run frontend:dev` on port **3090**, API `npm run backend:dev` on port **3080**.
- Meilisearch, Ollama, and the external RAG service are optional and are not required to register, log in, or open a chat.
