# Keyword Sets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user import a `.txt` file of comma-separated keywords, save it as a named, per-user "keyword set," and later preview/apply/rename/delete it from the existing Transcription Options "Names, jargon, or terms to expect" screen — without disturbing the existing ad-hoc "Add a term" flow or the deployment-level suggested-terms feature.

**Architecture:** New `KeywordSet` Mongoose collection (`{ userId, name, terms[], timestamps }`, unique on `(userId, name)`), scoped by `req.user.id` exactly like the existing `AgentApiKey` feature (same schema → model → methods → handlers → thin JS route layering). New `client/src/data-provider/` react-query hooks mirroring `useGetAgentApiKeysQuery`/`useCreateAgentApiKeyMutation`. Two new UI pieces (`ImportKeywordSetDialog`, `KeywordSetMenu`) added to the existing `TranscribeOptionsDialog.tsx` step-2 terms section, both writing into the dialog's existing local `termTags` state — the saved-set store and the active `termTags` list stay two separate things, exactly as required.

**Tech Stack:** Mongoose (`packages/data-schemas`), Express (`api/server/routes`, thin JS), TypeScript handlers (`packages/api`), React + `@tanstack/react-query` + Radix Popover + `@librechat/client` UI kit (`client/src`), Jest + `mongodb-memory-server`.

**Spec:** The full feature spec is the user's own message that kicked off this plan (objective, 18 numbered sections, acceptance criteria) — no separate spec file exists; this plan is written directly against it. Key requirements this plan satisfies: import `.txt` → preview → name → save+apply (§1, §5, §6); active keywords vs. saved sets are distinct (§2); per-user server-side persistence, not localStorage (§3); list/preview/apply/rename/delete (§7); apply asks Replace vs. Merge (§8); built-in "Add a term" flow is untouched (§9); recovery via "Saved keyword sets → Apply" without re-uploading (§11); duplicate set names are rejected with a clear error, not silently overwritten or auto-suffixed (§12); user-friendly errors, no raw backend errors surfaced (§13); ownership enforced server-side (§14).

## Global Constraints

- All new backend logic is TypeScript in `packages/api` (handlers) and `packages/data-schemas` (schema/model/methods) — `/api` only gets a thin JS route file, per project convention.
- Never use `any`; avoid `unknown`/`Record<string, unknown>` — reuse or extend types already in `packages/data-provider`.
- No new dependencies — everything needed (Radix Popover, `FileReader`, Mongoose, `@librechat/client` UI primitives) is already in the repo.
- No RBAC/permission-type gating — this is a plain per-user resource like `Preset`/`AgentApiKey`, not a role-gated feature like Memories.
- Skip "duplicate a set" and "update a set from the current active keywords" — the spec explicitly marks these optional ("if practical... keep the first implementation focused if these are not necessary"). Rename + delete + replace/merge-apply cover the required surface.
- Import applies as a **merge** into whatever is currently in the dialog (safe default, never silently destroys manually-typed terms); applying an **existing saved set** asks Replace vs. Merge only when there's something to lose (`termTags.length > 0`), otherwise applies directly — both satisfy the spec's "no silent, unexpected loss" requirement (§8) with the least UI.
- Fix all ESLint/TypeScript diagnostics introduced; run Prettier/lint auto-fix before each commit.

---

## Task 1: Backend data model — schema, model, CRUD methods

**Files:**
- Create: `packages/data-schemas/src/schema/keywordSet.ts`
- Create: `packages/data-schemas/src/models/keywordSet.ts`
- Modify: `packages/data-schemas/src/models/index.ts`
- Create: `packages/data-schemas/src/methods/keywordSet.ts`
- Modify: `packages/data-schemas/src/methods/index.ts`
- Test: `packages/data-schemas/src/methods/keywordSet.spec.ts`

**Interfaces:**
- Produces: `IKeywordSet` (Mongoose document type, from `~/schema/keywordSet`), `createKeywordSetModel(mongoose)` registering model name `'KeywordSet'`, `createKeywordSetMethods(mongoose)` returning `{ listKeywordSets, createKeywordSet, updateKeywordSet, deleteKeywordSet }` — all four consumed by Task 2's handlers.
- `KeywordSetListItem = { id: string; name: string; terms: string[]; createdAt: Date; updatedAt: Date }` is the shape every method resolves to (for list items and the create/update result alike).

- [ ] **Step 1: Write the schema**

`packages/data-schemas/src/schema/keywordSet.ts`:

```ts
import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IKeywordSet extends Document {
  userId: Types.ObjectId;
  name: string;
  terms: string[];
  createdAt: Date;
  updatedAt: Date;
}

const keywordSetSchema: Schema<IKeywordSet> = new Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    terms: {
      type: [String],
      required: true,
      validate: {
        validator: (terms: string[]) => terms.length > 0,
        message: 'A keyword set must contain at least one term.',
      },
    },
  },
  { timestamps: true },
);

keywordSetSchema.index({ userId: 1, name: 1 }, { unique: true });

export default keywordSetSchema;
```

- [ ] **Step 2: Write the model**

`packages/data-schemas/src/models/keywordSet.ts`:

```ts
import { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import keywordSetSchema, { IKeywordSet } from '~/schema/keywordSet';

export function createKeywordSetModel(mongoose: typeof import('mongoose')): Model<IKeywordSet> {
  applyTenantIsolation(keywordSetSchema);
  return (
    mongoose.models.KeywordSet || mongoose.model<IKeywordSet>('KeywordSet', keywordSetSchema)
  );
}
```

- [ ] **Step 3: Register the model**

In `packages/data-schemas/src/models/index.ts`, add the import next to the `AgentApiKey` import (around line 6):

```ts
import { createKeywordSetModel } from './keywordSet';
```

Add to the returned type object next to `AgentApiKey` (around line 52):

```ts
  KeywordSet: ReturnType<typeof createKeywordSetModel>;
```

Add to the returned instance object next to `AgentApiKey` (around line 92):

```ts
    KeywordSet: createKeywordSetModel(mongoose),
```

- [ ] **Step 4: Write the failing methods test**

`packages/data-schemas/src/methods/keywordSet.spec.ts`:

```ts
import mongoose from 'mongoose';
import { logger, createModels } from '..';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createKeywordSetMethods } from './keywordSet';

logger.silent = true;

let KeywordSet: mongoose.Model<unknown>;
let methods: ReturnType<typeof createKeywordSetMethods>;
let mongoServer: MongoMemoryServer;

const userA = new mongoose.Types.ObjectId().toString();
const userB = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  KeywordSet = mongoose.models.KeywordSet;
  await KeywordSet.syncIndexes();
  methods = createKeywordSetMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await KeywordSet.deleteMany({});
});

describe('createKeywordSet', () => {
  test('persists a set and listKeywordSets returns it for that user', async () => {
    const created = await methods.createKeywordSet(userA, {
      name: 'Financial Crime',
      terms: ['Serious Fraud Office', 'restraint order'],
    });
    expect(created.name).toBe('Financial Crime');
    expect(created.terms).toEqual(['Serious Fraud Office', 'restraint order']);

    const list = await methods.listKeywordSets(userA);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  test('rejects a duplicate name for the same user', async () => {
    await methods.createKeywordSet(userA, { name: 'Financial Crime', terms: ['a'] });
    await expect(
      methods.createKeywordSet(userA, { name: 'Financial Crime', terms: ['b'] }),
    ).rejects.toThrow();
  });

  test('allows the same name for a different user', async () => {
    await methods.createKeywordSet(userA, { name: 'Financial Crime', terms: ['a'] });
    await expect(
      methods.createKeywordSet(userB, { name: 'Financial Crime', terms: ['b'] }),
    ).resolves.toMatchObject({ name: 'Financial Crime' });
  });

  test('rejects an empty terms array', async () => {
    await expect(methods.createKeywordSet(userA, { name: 'Empty', terms: [] })).rejects.toThrow();
  });
});

describe('user isolation', () => {
  test('listKeywordSets only returns the calling user\'s sets', async () => {
    await methods.createKeywordSet(userA, { name: 'A Set', terms: ['x'] });
    await methods.createKeywordSet(userB, { name: 'B Set', terms: ['y'] });

    expect(await methods.listKeywordSets(userA)).toHaveLength(1);
    expect(await methods.listKeywordSets(userB)).toHaveLength(1);
  });

  test('updateKeywordSet cannot rename another user\'s set', async () => {
    const set = await methods.createKeywordSet(userA, { name: 'A Set', terms: ['x'] });
    const result = await methods.updateKeywordSet(set.id, userB, { name: 'Hijacked' });
    expect(result).toBeNull();
    expect((await methods.listKeywordSets(userA))[0].name).toBe('A Set');
  });

  test('deleteKeywordSet cannot delete another user\'s set', async () => {
    const set = await methods.createKeywordSet(userA, { name: 'A Set', terms: ['x'] });
    const deleted = await methods.deleteKeywordSet(set.id, userB);
    expect(deleted).toBe(false);
    expect(await methods.listKeywordSets(userA)).toHaveLength(1);
  });
});

describe('updateKeywordSet', () => {
  test('renames a set in place', async () => {
    const set = await methods.createKeywordSet(userA, { name: 'Old Name', terms: ['x'] });
    const updated = await methods.updateKeywordSet(set.id, userA, { name: 'New Name' });
    expect(updated?.name).toBe('New Name');
    expect(updated?.terms).toEqual(['x']);
  });

  test('replaces terms in place', async () => {
    const set = await methods.createKeywordSet(userA, { name: 'Set', terms: ['x'] });
    const updated = await methods.updateKeywordSet(set.id, userA, { terms: ['y', 'z'] });
    expect(updated?.terms).toEqual(['y', 'z']);
  });
});

describe('deleteKeywordSet', () => {
  test('removes the set', async () => {
    const set = await methods.createKeywordSet(userA, { name: 'Set', terms: ['x'] });
    expect(await methods.deleteKeywordSet(set.id, userA)).toBe(true);
    expect(await methods.listKeywordSets(userA)).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd packages/data-schemas && npx jest keywordSet.spec.ts`
Expected: FAIL — `Cannot find module './keywordSet'` (methods file doesn't exist yet).

- [ ] **Step 6: Write the methods implementation**

`packages/data-schemas/src/methods/keywordSet.ts`:

```ts
import type { Types } from 'mongoose';
import type { IKeywordSet } from '~/schema/keywordSet';

export interface KeywordSetListItem {
  id: string;
  name: string;
  terms: string[];
  createdAt: Date;
  updatedAt: Date;
}

function toListItem(doc: IKeywordSet): KeywordSetListItem {
  return {
    id: (doc._id as Types.ObjectId).toString(),
    name: doc.name,
    terms: doc.terms,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function createKeywordSetMethods(mongoose: typeof import('mongoose')): {
  listKeywordSets: (userId: string | Types.ObjectId) => Promise<KeywordSetListItem[]>;
  createKeywordSet: (
    userId: string | Types.ObjectId,
    data: { name: string; terms: string[] },
  ) => Promise<KeywordSetListItem>;
  updateKeywordSet: (
    id: string | Types.ObjectId,
    userId: string | Types.ObjectId,
    data: { name?: string; terms?: string[] },
  ) => Promise<KeywordSetListItem | null>;
  deleteKeywordSet: (
    id: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ) => Promise<boolean>;
} {
  async function listKeywordSets(userId: string | Types.ObjectId): Promise<KeywordSetListItem[]> {
    const KeywordSet = mongoose.models.KeywordSet;
    const sets = (await KeywordSet.find({ userId })
      .sort({ updatedAt: -1 })
      .lean()) as unknown as IKeywordSet[];
    return sets.map(toListItem);
  }

  async function createKeywordSet(
    userId: string | Types.ObjectId,
    data: { name: string; terms: string[] },
  ): Promise<KeywordSetListItem> {
    const KeywordSet = mongoose.models.KeywordSet;
    const doc = await KeywordSet.create({ userId, name: data.name, terms: data.terms });
    return toListItem(doc as unknown as IKeywordSet);
  }

  async function updateKeywordSet(
    id: string | Types.ObjectId,
    userId: string | Types.ObjectId,
    data: { name?: string; terms?: string[] },
  ): Promise<KeywordSetListItem | null> {
    const KeywordSet = mongoose.models.KeywordSet;
    const doc = (await KeywordSet.findOneAndUpdate(
      { _id: id, userId },
      { $set: data },
      { new: true },
    ).lean()) as unknown as IKeywordSet | null;
    return doc ? toListItem(doc) : null;
  }

  async function deleteKeywordSet(
    id: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ): Promise<boolean> {
    const KeywordSet = mongoose.models.KeywordSet;
    const result = await KeywordSet.deleteOne({ _id: id, userId });
    return result.deletedCount > 0;
  }

  return { listKeywordSets, createKeywordSet, updateKeywordSet, deleteKeywordSet };
}
```

- [ ] **Step 7: Register methods in the aggregator**

In `packages/data-schemas/src/methods/index.ts`, add the import next to `createAgentApiKeyMethods`:

```ts
import { createKeywordSetMethods, type KeywordSetListItem } from './keywordSet';
```

Add `KeywordSetMethods` to the intersected `AllMethods` type (mirroring the `AgentApiKeyMethods &` line) and spread `...createKeywordSetMethods(mongoose)` into the returned object next to `...createAgentApiKeyMethods(mongoose)`. Export `KeywordSetListItem` alongside the other named exports at the bottom of the file if the file re-exports method-specific types (check how `AgentApiKeyMethods`/its item type is exported and mirror it exactly).

- [ ] **Step 8: Run test to verify it passes**

Run: `cd packages/data-schemas && npx jest keywordSet.spec.ts`
Expected: PASS, all 9 tests green.

- [ ] **Step 9: Commit**

```bash
git add packages/data-schemas/src/schema/keywordSet.ts packages/data-schemas/src/models/keywordSet.ts packages/data-schemas/src/models/index.ts packages/data-schemas/src/methods/keywordSet.ts packages/data-schemas/src/methods/index.ts packages/data-schemas/src/methods/keywordSet.spec.ts
git commit -m "feat(keyword-sets): add KeywordSet schema, model, and CRUD methods"
```

---

## Task 2: Backend HTTP layer — handlers + route wiring

**Files:**
- Create: `packages/api/src/keywordSets/handlers.ts`
- Create: `packages/api/src/keywordSets/index.ts`
- Modify: `packages/api/src/index.ts`
- Create: `api/server/routes/keywordSets.js`
- Modify: `api/server/routes/index.js`
- Modify: `api/server/index.js`

**Interfaces:**
- Consumes: `listKeywordSets`, `createKeywordSet`, `updateKeywordSet`, `deleteKeywordSet` from Task 1 (available via `~/models` in `/api`, same as `~/models`'s `getAgentApiKeyById` etc.).
- Produces: `createKeywordSetHandlers(deps)` → `{ listKeywordSets, createKeywordSet, updateKeywordSet, deleteKeywordSet }` Express handlers, exported from `@librechat/api`; mounted at `/api/keyword-sets`.

- [ ] **Step 1: Write the handlers**

`packages/api/src/keywordSets/handlers.ts`:

```ts
import { logger } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Types } from 'mongoose';

export interface KeywordSetListItem {
  id: string;
  name: string;
  terms: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface KeywordSetHandlerDependencies {
  listKeywordSets: (userId: string | Types.ObjectId) => Promise<KeywordSetListItem[]>;
  createKeywordSet: (
    userId: string | Types.ObjectId,
    data: { name: string; terms: string[] },
  ) => Promise<KeywordSetListItem>;
  updateKeywordSet: (
    id: string | Types.ObjectId,
    userId: string | Types.ObjectId,
    data: { name?: string; terms?: string[] },
  ) => Promise<KeywordSetListItem | null>;
  deleteKeywordSet: (
    id: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ) => Promise<boolean>;
}

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    _id: Types.ObjectId;
  };
}

/** Comma-delimited import terms and manually-typed terms both flow through
 *  this same validation - trims, drops empties, dedupes case-insensitively,
 *  and caps length so one bad file can't create an unbounded document. */
function sanitizeTerms(rawTerms: unknown): string[] | null {
  if (!Array.isArray(rawTerms)) {
    return null;
  }
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of rawTerms) {
    if (typeof raw !== 'string') {
      continue;
    }
    const term = raw.trim();
    if (term === '' || term.length > 200 || seen.has(term.toLowerCase())) {
      continue;
    }
    seen.add(term.toLowerCase());
    terms.push(term);
  }
  return terms.slice(0, 500);
}

export function createKeywordSetHandlers(deps: KeywordSetHandlerDependencies): {
  listKeywordSets: (req: AuthenticatedRequest, res: Response) => Promise<void>;
  createKeywordSet: (req: AuthenticatedRequest, res: Response) => Promise<Response | undefined>;
  updateKeywordSet: (req: AuthenticatedRequest, res: Response) => Promise<Response | undefined>;
  deleteKeywordSet: (req: AuthenticatedRequest, res: Response) => Promise<Response | undefined>;
} {
  async function listKeywordSets(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const keywordSets = await deps.listKeywordSets(req.user?.id || '');
      res.status(200).json({ keywordSets });
    } catch (error) {
      logger.error('[listKeywordSets] Error listing keyword sets:', error);
      res.status(500).json({ error: 'Failed to load keyword sets' });
    }
  }

  async function createKeywordSet(
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<Response | undefined> {
    try {
      const { name, terms: rawTerms } = req.body;

      if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'Keyword set name is required' });
      }

      const terms = sanitizeTerms(rawTerms);
      if (!terms || terms.length === 0) {
        return res.status(400).json({ error: 'Keyword set must contain at least one term' });
      }

      const result = await deps.createKeywordSet(req.user?.id || '', {
        name: name.trim(),
        terms,
      });

      res.status(201).json(result);
    } catch (error) {
      const isDuplicateKey = (error as { code?: number })?.code === 11000;
      if (isDuplicateKey) {
        return res.status(409).json({ error: 'A keyword set with this name already exists' });
      }
      logger.error('[createKeywordSet] Error creating keyword set:', error);
      res.status(500).json({ error: 'Failed to save keyword set' });
    }
  }

  async function updateKeywordSet(
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<Response | undefined> {
    try {
      const { name, terms: rawTerms } = req.body;
      const update: { name?: string; terms?: string[] } = {};

      if (name != null) {
        if (typeof name !== 'string' || name.trim() === '') {
          return res.status(400).json({ error: 'Keyword set name cannot be empty' });
        }
        update.name = name.trim();
      }

      if (rawTerms != null) {
        const terms = sanitizeTerms(rawTerms);
        if (!terms || terms.length === 0) {
          return res.status(400).json({ error: 'Keyword set must contain at least one term' });
        }
        update.terms = terms;
      }

      const result = await deps.updateKeywordSet(req.params.id, req.user?.id || '', update);
      if (!result) {
        return res.status(404).json({ error: 'Keyword set not found' });
      }
      res.status(200).json(result);
    } catch (error) {
      const isDuplicateKey = (error as { code?: number })?.code === 11000;
      if (isDuplicateKey) {
        return res.status(409).json({ error: 'A keyword set with this name already exists' });
      }
      logger.error('[updateKeywordSet] Error updating keyword set:', error);
      res.status(500).json({ error: 'Failed to update keyword set' });
    }
  }

  async function deleteKeywordSet(
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<Response | undefined> {
    try {
      const deleted = await deps.deleteKeywordSet(req.params.id, req.user?.id || '');
      if (!deleted) {
        return res.status(404).json({ error: 'Keyword set not found' });
      }
      res.status(204).send();
    } catch (error) {
      logger.error('[deleteKeywordSet] Error deleting keyword set:', error);
      res.status(500).json({ error: 'Failed to delete keyword set' });
    }
  }

  return { listKeywordSets, createKeywordSet, updateKeywordSet, deleteKeywordSet };
}
```

- [ ] **Step 2: Export the handlers**

`packages/api/src/keywordSets/index.ts`:

```ts
export * from './handlers';
```

In `packages/api/src/index.ts`, add next to `export * from './apiKeys';`:

```ts
export * from './keywordSets';
```

- [ ] **Step 3: Write the thin JS route**

`api/server/routes/keywordSets.js`:

```js
const express = require('express');
const { createKeywordSetHandlers } = require('@librechat/api');
const {
  listKeywordSets,
  createKeywordSet,
  updateKeywordSet,
  deleteKeywordSet,
} = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

const handlers = createKeywordSetHandlers({
  listKeywordSets,
  createKeywordSet,
  updateKeywordSet,
  deleteKeywordSet,
});

router.use(requireJwtAuth);

router.get('/', handlers.listKeywordSets);
router.post('/', handlers.createKeywordSet);
router.put('/:id', handlers.updateKeywordSet);
router.delete('/:id', handlers.deleteKeywordSet);

module.exports = router;
```

- [ ] **Step 4: Register the route**

In `api/server/routes/index.js`, add next to `const apiKeys = require('./apiKeys');`:

```js
const keywordSets = require('./keywordSets');
```

Add `keywordSets,` to the exported object next to `apiKeys,`.

In `api/server/index.js`, add next to `app.use('/api/api-keys', routes.apiKeys);`:

```js
  app.use('/api/keyword-sets', routes.keywordSets);
```

- [ ] **Step 5: Verify `~/models` re-exports the new methods**

Check `api/models/index.js` (or wherever `~/models` is assembled) already spreads everything from `createMethods`/`AllMethods` — `getAgentApiKeyById` etc. reach it the same way. If it's a blanket re-export, no change is needed; if it explicitly lists names, add `listKeywordSets, createKeywordSet, updateKeywordSet, deleteKeywordSet` to that list.

- [ ] **Step 6: Manual verification (no dedicated handler test — matches existing `apiKeys.js` convention, which also has none)**

Run: `npm run backend:dev`, then with a valid session cookie:

```bash
curl -s -X POST http://localhost:3080/api/keyword-sets \
  -H "Content-Type: application/json" -b "<cookie>" \
  -d '{"name":"Test Set","terms":["Serious Fraud Office","restraint order"]}'

curl -s http://localhost:3080/api/keyword-sets -b "<cookie>"
```

Expected: `POST` returns `201` with the created set; `GET` returns `{"keywordSets":[...]}` including it. Re-POST the same name and confirm `409`.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/keywordSets api/server/routes/keywordSets.js api/server/routes/index.js api/server/index.js packages/api/src/index.ts
git commit -m "feat(keyword-sets): add keyword set HTTP handlers and routes"
```

---

## Task 3: Shared types + data-provider client

**Files:**
- Modify: `packages/data-provider/src/api-endpoints.ts`
- Modify: `packages/data-provider/src/types.ts`
- Modify: `packages/data-provider/src/data-service.ts`
- Modify: `packages/data-provider/src/keys.ts`
- Modify: `packages/data-provider/src/react-query/react-query-service.ts`

**Interfaces:**
- Produces: `TKeywordSet`, `TKeywordSetListResponse`, `TKeywordSetCreateRequest`, `TKeywordSetUpdateRequest` (types); `useGetKeywordSetsQuery`, `useCreateKeywordSetMutation`, `useUpdateKeywordSetMutation`, `useDeleteKeywordSetMutation` (hooks) — all consumed by Task 5's UI components.

- [ ] **Step 1: Add endpoint builders**

In `packages/data-provider/src/api-endpoints.ts`, add next to the `apiKeys`/`apiKeyById` block:

```ts
const keywordSetsEndpoint = `${BASE_URL}/api/keyword-sets`;

export const keywordSets = () => keywordSetsEndpoint;

export const keywordSetById = (id: string) => `${keywordSetsEndpoint}/${encodeURIComponent(id)}`;
```

- [ ] **Step 2: Add types**

In `packages/data-provider/src/types.ts`, add next to the `TAgentApiKey*` block:

```ts
export type TKeywordSet = {
  id: string;
  name: string;
  terms: string[];
  createdAt: string;
  updatedAt: string;
};

export type TKeywordSetListResponse = {
  keywordSets: TKeywordSet[];
};

export type TKeywordSetCreateRequest = {
  name: string;
  terms: string[];
};

export type TKeywordSetUpdateRequest = {
  name?: string;
  terms?: string[];
};
```

- [ ] **Step 3: Add data-service functions**

In `packages/data-provider/src/data-service.ts`, add next to the `getAgentApiKeys`/`createAgentApiKey`/`deleteAgentApiKey` block:

```ts
export function getKeywordSets(): Promise<t.TKeywordSetListResponse> {
  return request.get(endpoints.keywordSets());
}

export function createKeywordSet(payload: t.TKeywordSetCreateRequest): Promise<t.TKeywordSet> {
  return request.post(endpoints.keywordSets(), payload);
}

export function updateKeywordSet(
  id: string,
  payload: t.TKeywordSetUpdateRequest,
): Promise<t.TKeywordSet> {
  return request.put(endpoints.keywordSetById(id), payload);
}

export function deleteKeywordSet(id: string): Promise<void> {
  return request.delete(endpoints.keywordSetById(id));
}
```

- [ ] **Step 4: Add query/mutation keys**

In `packages/data-provider/src/keys.ts`, add `keywordSets = 'keywordSets'` to the `QueryKeys` enum (next to `agentApiKeys`) and `createKeywordSet = 'createKeywordSet'`, `updateKeywordSet = 'updateKeywordSet'`, `deleteKeywordSet = 'deleteKeywordSet'` to the `MutationKeys` enum (next to `createAgentApiKey`/`deleteAgentApiKey`).

- [ ] **Step 5: Add react-query hooks**

In `packages/data-provider/src/react-query/react-query-service.ts`, add next to the `useGetAgentApiKeysQuery`/`useCreateAgentApiKeyMutation`/`useDeleteAgentApiKeyMutation` block:

```ts
export const useGetKeywordSetsQuery = (
  config?: UseQueryOptions<t.TKeywordSetListResponse>,
): QueryObserverResult<t.TKeywordSetListResponse> => {
  return useQuery<t.TKeywordSetListResponse>(
    [QueryKeys.keywordSets],
    () => dataService.getKeywordSets(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      ...config,
    },
  );
};

export const useCreateKeywordSetMutation = (): UseMutationResult<
  t.TKeywordSet,
  unknown,
  t.TKeywordSetCreateRequest
> => {
  const queryClient = useQueryClient();
  return useMutation((payload: t.TKeywordSetCreateRequest) => dataService.createKeywordSet(payload), {
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.keywordSets]);
    },
  });
};

export const useUpdateKeywordSetMutation = (): UseMutationResult<
  t.TKeywordSet,
  unknown,
  { id: string; payload: t.TKeywordSetUpdateRequest }
> => {
  const queryClient = useQueryClient();
  return useMutation(
    ({ id, payload }: { id: string; payload: t.TKeywordSetUpdateRequest }) =>
      dataService.updateKeywordSet(id, payload),
    {
      onSuccess: () => {
        queryClient.invalidateQueries([QueryKeys.keywordSets]);
      },
    },
  );
};

export const useDeleteKeywordSetMutation = (): UseMutationResult<void, unknown, string> => {
  const queryClient = useQueryClient();
  return useMutation((id: string) => dataService.deleteKeywordSet(id), {
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.keywordSets]);
    },
  });
};
```

- [ ] **Step 6: Build and typecheck**

Run: `npm run build:data-provider`
Expected: builds clean, no TS errors.

- [ ] **Step 7: Commit**

```bash
git add packages/data-provider/src/api-endpoints.ts packages/data-provider/src/types.ts packages/data-provider/src/data-service.ts packages/data-provider/src/keys.ts packages/data-provider/src/react-query/react-query-service.ts
git commit -m "feat(keyword-sets): add data-provider types, endpoints, and react-query hooks"
```

---

## Task 4: `.txt` parser (TDD)

**Files:**
- Create: `client/src/components/AudioTranscriber/parseKeywordFile.ts`
- Test: `client/src/components/AudioTranscriber/__tests__/parseKeywordFile.spec.ts`

**Interfaces:**
- Produces: `parseKeywordFile(text: string): string[]` — pure function, consumed by `ImportKeywordSetDialog` in Task 5.

- [ ] **Step 1: Write the failing test**

`client/src/components/AudioTranscriber/__tests__/parseKeywordFile.spec.ts`:

```ts
import { parseKeywordFile } from '../parseKeywordFile';

describe('parseKeywordFile', () => {
  test('splits comma-separated terms and trims whitespace', () => {
    expect(parseKeywordFile('Serious Fraud Office, restraint order,  Crown Solicitor')).toEqual([
      'Serious Fraud Office',
      'restraint order',
      'Crown Solicitor',
    ]);
  });

  test('drops empty terms from double commas', () => {
    expect(parseKeywordFile('a, , b')).toEqual(['a', 'b']);
  });

  test('drops duplicate terms case-insensitively, keeping first occurrence', () => {
    expect(parseKeywordFile('Financial Intelligence Unit, financial intelligence unit')).toEqual([
      'Financial Intelligence Unit',
    ]);
  });

  test('supports a trailing comma', () => {
    expect(parseKeywordFile('a, b,')).toEqual(['a', 'b']);
  });

  test('preserves internal punctuation of a term', () => {
    expect(parseKeywordFile('Section 61A, Proceeds of Crime')).toEqual([
      'Section 61A',
      'Proceeds of Crime',
    ]);
  });

  test('returns an empty array for an empty or whitespace-only file', () => {
    expect(parseKeywordFile('')).toEqual([]);
    expect(parseKeywordFile('   \n  ')).toEqual([]);
  });

  test('matches the spec example end to end', () => {
    expect(
      parseKeywordFile(
        ' Serious Fraud Office, Financial Intelligence Unit, , Proceeds of Crime, Financial Intelligence Unit,',
      ),
    ).toEqual(['Serious Fraud Office', 'Financial Intelligence Unit', 'Proceeds of Crime']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx jest parseKeywordFile.spec.ts`
Expected: FAIL — `Cannot find module '../parseKeywordFile'`.

- [ ] **Step 3: Write the implementation**

`client/src/components/AudioTranscriber/parseKeywordFile.ts`:

```ts
/** Splits a `.txt` keyword-set file on commas only (no semicolon/newline
 *  splitting, unlike the dialog's own free-text `parseTermTags`) - terms may
 *  freely contain any punctuation except a comma, which is reserved as the
 *  delimiter and cannot be escaped in this format. */
export function parseKeywordFile(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.split(',')) {
    const term = raw.trim();
    if (term === '' || seen.has(term.toLowerCase())) {
      continue;
    }
    seen.add(term.toLowerCase());
    terms.push(term);
  }
  return terms;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx jest parseKeywordFile.spec.ts`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/AudioTranscriber/parseKeywordFile.ts client/src/components/AudioTranscriber/__tests__/parseKeywordFile.spec.ts
git commit -m "feat(keyword-sets): add comma-separated .txt keyword parser"
```

---

## Task 5: Keyword Sets UI components

**Files:**
- Create: `client/src/components/AudioTranscriber/KeywordSets.tsx`

**Interfaces:**
- Consumes: `parseKeywordFile` (Task 4); `useGetKeywordSetsQuery`, `useCreateKeywordSetMutation`, `useUpdateKeywordSetMutation`, `useDeleteKeywordSetMutation` (Task 3); `TKeywordSet` (Task 3); `OGDialog`, `OGDialogTemplate`, `Button`, `Input`, `Label`, `Spinner`, `useToastContext`, `usePopoverZIndex` from `@librechat/client`.
- Produces: `ImportKeywordSetDialog` (props `{ open, onOpenChange, onApply(terms: string[]): void }`) and `KeywordSetMenu` (props `{ hasActiveTerms: boolean, onApply(terms: string[], mode: 'replace' | 'merge'): void }`) — both consumed by Task 6's edit to `TranscribeOptionsDialog.tsx`.

- [ ] **Step 1: Write the component file**

`client/src/components/AudioTranscriber/KeywordSets.tsx`:

```tsx
import { useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { BookMarked, ChevronRight, Loader2 } from 'lucide-react';
import type { ChangeEvent } from 'react';
import {
  OGDialog,
  OGDialogTemplate,
  Button,
  Input,
  Label,
  Spinner,
  useToastContext,
  usePopoverZIndex,
} from '@librechat/client';
import type { TKeywordSet } from 'librechat-data-provider';
import {
  useGetKeywordSetsQuery,
  useCreateKeywordSetMutation,
  useUpdateKeywordSetMutation,
  useDeleteKeywordSetMutation,
} from '~/data-provider';
import useLocalize from '~/hooks/useLocalize';
import { parseKeywordFile } from './parseKeywordFile';
import { cn } from '~/utils';

interface ImportKeywordSetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (terms: string[]) => void;
}

export function ImportKeywordSetDialog({ open, onOpenChange, onApply }: ImportKeywordSetDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const createMutation = useCreateKeywordSetMutation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [terms, setTerms] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const reset = () => {
    setFileName('');
    setTerms([]);
    setName('');
    setError('');
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const parsed = parseKeywordFile(text);
      if (parsed.length === 0) {
        setError(localize('com_ui_keyword_set_import_empty'));
        return;
      }
      setError('');
      setFileName(file.name);
      setTerms(parsed);
      setName(file.name.replace(/\.txt$/i, ''));
    };
    reader.onerror = () => setError(localize('com_ui_keyword_set_import_read_error'));
    reader.readAsText(file);
  };

  const handleImport = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(localize('com_ui_keyword_set_name_required'));
      return;
    }
    createMutation.mutate(
      { name: trimmedName, terms },
      {
        onSuccess: () => {
          showToast({ message: localize('com_ui_keyword_set_saved'), status: 'success' });
          onApply(terms);
          reset();
          onOpenChange(false);
        },
        onError: () => setError(localize('com_ui_keyword_set_save_error')),
      },
    );
  };

  return (
    <OGDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
        }
        onOpenChange(next);
      }}
    >
      <OGDialogTemplate
        title={localize('com_ui_keyword_set_import_title')}
        className="w-11/12 sm:w-[26rem]"
        main={
          <div className="flex flex-col gap-4">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt"
              className="hidden"
              onChange={handleFileChange}
            />
            <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
              {fileName || localize('com_ui_keyword_set_choose_file')}
            </Button>
            {terms.length > 0 && (
              <>
                <p className="text-xs text-text-secondary">
                  {localize('com_ui_keyword_set_terms_detected', { 0: String(terms.length) })}
                </p>
                <ul className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-border-light p-2">
                  {terms.map((term) => (
                    <li
                      key={term}
                      className="rounded-full border border-border-medium px-2 py-0.5 text-xs text-text-secondary"
                    >
                      {term}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="keyword-set-name">
                    {localize('com_ui_keyword_set_name_label')}
                  </Label>
                  <Input
                    id="keyword-set-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              </>
            )}
            {error !== '' && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
          </div>
        }
        selection={
          terms.length > 0
            ? {
                selectHandler: handleImport,
                selectText: createMutation.isLoading ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  localize('com_ui_keyword_set_import_apply')
                ),
              }
            : undefined
        }
      />
    </OGDialog>
  );
}

type RowMode = 'idle' | 'confirm-apply' | 'confirm-delete' | 'rename';

function KeywordSetRow({
  set,
  hasActiveTerms,
  onApply,
}: {
  set: TKeywordSet;
  hasActiveTerms: boolean;
  onApply: (terms: string[], mode: 'replace' | 'merge') => void;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const updateMutation = useUpdateKeywordSetMutation();
  const deleteMutation = useDeleteKeywordSetMutation();
  const [mode, setMode] = useState<RowMode>('idle');
  const [expanded, setExpanded] = useState(false);
  const [renameValue, setRenameValue] = useState(set.name);

  const handleApplyClick = () => {
    if (!hasActiveTerms) {
      onApply(set.terms, 'replace');
      return;
    }
    setMode('confirm-apply');
  };

  const handleRename = () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === set.name) {
      setMode('idle');
      return;
    }
    updateMutation.mutate(
      { id: set.id, payload: { name: trimmed } },
      {
        onSuccess: () => {
          showToast({ message: localize('com_ui_keyword_set_renamed'), status: 'success' });
          setMode('idle');
        },
        onError: () =>
          showToast({ message: localize('com_ui_keyword_set_save_error'), status: 'error' }),
      },
    );
  };

  const handleDelete = () => {
    deleteMutation.mutate(set.id, {
      onSuccess: () =>
        showToast({ message: localize('com_ui_keyword_set_deleted'), status: 'success' }),
      onError: () =>
        showToast({ message: localize('com_ui_keyword_set_delete_error'), status: 'error' }),
    });
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border-light p-2.5">
      <div className="flex items-center justify-between gap-2">
        {mode === 'rename' ? (
          <Input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                handleRename();
              }
            }}
            className="h-7 text-sm"
          />
        ) : (
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
              aria-hidden="true"
            />
            <span className="truncate text-sm font-medium text-text-primary">{set.name}</span>
            <span className="shrink-0 text-xs text-text-secondary">
              {localize('com_ui_keyword_set_term_count', { 0: String(set.terms.length) })}
            </span>
          </button>
        )}
        <div className="flex shrink-0 items-center gap-2 text-xs">
          {mode === 'rename' ? (
            <>
              <button type="button" onClick={handleRename} className="font-medium text-green-600 hover:underline dark:text-green-400">
                {localize('com_ui_save')}
              </button>
              <button type="button" onClick={() => setMode('idle')} className="text-text-secondary hover:underline">
                {localize('com_ui_cancel')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                aria-label={localize('com_ui_keyword_set_rename')}
                onClick={() => {
                  setRenameValue(set.name);
                  setMode('rename');
                }}
                className="text-text-secondary hover:text-text-primary hover:underline"
              >
                {localize('com_ui_keyword_set_rename')}
              </button>
              <button
                type="button"
                aria-label={localize('com_ui_keyword_set_delete')}
                onClick={() => setMode('confirm-delete')}
                className="text-text-secondary hover:text-red-600 hover:underline dark:hover:text-red-400"
              >
                {localize('com_ui_keyword_set_delete')}
              </button>
            </>
          )}
        </div>
      </div>

      {expanded && mode === 'idle' && (
        <div className="flex flex-wrap gap-1 pl-5">
          {set.terms.map((term) => (
            <span
              key={term}
              className="rounded-full border border-border-medium px-2 py-0.5 text-xs text-text-secondary"
            >
              {term}
            </span>
          ))}
        </div>
      )}

      {mode === 'confirm-delete' && (
        <div className="flex items-center justify-between gap-2 pl-5 text-xs">
          <span className="text-text-secondary">{localize('com_ui_keyword_set_delete_confirm')}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleDelete}
              className="font-medium text-red-600 hover:underline dark:text-red-400"
            >
              {deleteMutation.isLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                localize('com_ui_delete')
              )}
            </button>
            <button type="button" onClick={() => setMode('idle')} className="text-text-secondary hover:underline">
              {localize('com_ui_cancel')}
            </button>
          </div>
        </div>
      )}

      {mode === 'confirm-apply' && (
        <div className="flex items-center justify-between gap-2 pl-5 text-xs">
          <span className="text-text-secondary">{localize('com_ui_keyword_set_apply_prompt')}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                onApply(set.terms, 'replace');
                setMode('idle');
              }}
              className="font-medium text-green-600 hover:underline dark:text-green-400"
            >
              {localize('com_ui_keyword_set_replace')}
            </button>
            <button
              type="button"
              onClick={() => {
                onApply(set.terms, 'merge');
                setMode('idle');
              }}
              className="font-medium text-green-600 hover:underline dark:text-green-400"
            >
              {localize('com_ui_keyword_set_merge')}
            </button>
            <button type="button" onClick={() => setMode('idle')} className="text-text-secondary hover:underline">
              {localize('com_ui_cancel')}
            </button>
          </div>
        </div>
      )}

      {mode === 'idle' && (
        <Button type="button" variant="outline" size="sm" onClick={handleApplyClick} className="self-start">
          {localize('com_ui_keyword_set_apply')}
        </Button>
      )}
    </div>
  );
}

interface KeywordSetMenuProps {
  hasActiveTerms: boolean;
  onApply: (terms: string[], mode: 'replace' | 'merge') => void;
}

export function KeywordSetMenu({ hasActiveTerms, onApply }: KeywordSetMenuProps) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const zIndex = usePopoverZIndex();
  const { data } = useGetKeywordSetsQuery({ enabled: open });
  const sets = data?.keywordSets ?? [];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button type="button" variant="outline" className="shrink-0">
          <BookMarked className="mr-2 h-4 w-4" aria-hidden="true" />
          {localize('com_ui_keyword_set_saved_sets')}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          style={{ zIndex, pointerEvents: 'auto' }}
          className="max-h-80 w-[20rem] overflow-y-auto rounded-lg border border-border-medium bg-surface-primary p-2 shadow-lg"
          onWheel={(event) => {
            event.currentTarget.scrollTop += event.deltaY;
          }}
        >
          {sets.length === 0 ? (
            <p className="p-2 text-xs italic text-text-tertiary">
              {localize('com_ui_keyword_set_none_saved')}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {sets.map((set) => (
                <KeywordSetRow
                  key={set.id}
                  set={set}
                  hasActiveTerms={hasActiveTerms}
                  onApply={(terms, mode) => {
                    onApply(terms, mode);
                    setOpen(false);
                  }}
                />
              ))}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd client && npx tsc --noEmit -p tsconfig.json` (or the project's existing typecheck script)
Expected: no new errors from `KeywordSets.tsx`.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/AudioTranscriber/KeywordSets.tsx
git commit -m "feat(keyword-sets): add import dialog and saved-sets menu components"
```

---

## Task 6: Wire into `TranscribeOptionsDialog.tsx`

**Files:**
- Modify: `client/src/components/AudioTranscriber/TranscribeOptionsDialog.tsx`

**Interfaces:**
- Consumes: `ImportKeywordSetDialog`, `KeywordSetMenu` from Task 5.

- [ ] **Step 1: Add the import**

Add to the import block at the top of the file, next to the other local import:

```tsx
import { ImportKeywordSetDialog, KeywordSetMenu } from './KeywordSets';
```

- [ ] **Step 2: Add local state and the apply handler**

In the component body, right after the existing `const [termDraft, setTermDraft] = useState('');` line:

```tsx
  const [importDialogOpen, setImportDialogOpen] = useState(false);
```

Right after `commitTermDraft` (after its closing brace, before `handleTermKeyDown`):

```tsx
  const applyKeywordTerms = (terms: string[], mode: 'replace' | 'merge' = 'replace') => {
    setTermTags((current) => {
      if (mode === 'replace') {
        return terms;
      }
      const existingLower = new Set(current.map((tag) => tag.toLowerCase()));
      const additions = terms.filter((term) => !existingLower.has(term.toLowerCase()));
      return [...current, ...additions];
    });
  };
```

- [ ] **Step 3: Add the UI row and the import dialog**

In the step-2 JSX, right after the closing `</div>` of the existing "Add a term" input row (the `<div className="flex gap-2">` block containing the `input` and the `Add` `Button`, immediately before the `{unusedSuggestions.length > 0 && (` block), add:

```tsx
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={() => setImportDialogOpen(true)}>
                      {localize('com_ui_keyword_set_import')}
                    </Button>
                    <KeywordSetMenu hasActiveTerms={termTags.length > 0} onApply={applyKeywordTerms} />
                  </div>
```

Immediately before the dialog's closing `</OGDialog>` (after the `OGDialogTemplate` closes), add:

```tsx
      <ImportKeywordSetDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        onApply={(terms) => applyKeywordTerms(terms, 'merge')}
      />
```

- [ ] **Step 4: Typecheck**

Run: `cd client && npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/AudioTranscriber/TranscribeOptionsDialog.tsx
git commit -m "feat(keyword-sets): wire keyword set import/apply into transcription options"
```

---

## Task 7: Localization keys

**Files:**
- Modify: `client/src/locales/en/translation.json`

**Interfaces:**
- Produces: every `com_ui_keyword_set_*` key referenced by Task 5 and Task 6.

- [ ] **Step 1: Add the keys**

Add next to the existing `com_ui_transcribe_options_terms_*` keys:

```json
  "com_ui_keyword_set_import": "Import keyword set",
  "com_ui_keyword_set_saved_sets": "Saved keyword sets",
  "com_ui_keyword_set_none_saved": "No saved keyword sets yet.",
  "com_ui_keyword_set_import_title": "Import Keyword Set",
  "com_ui_keyword_set_choose_file": "Choose a .txt file",
  "com_ui_keyword_set_terms_detected": "Detected {{0}} terms",
  "com_ui_keyword_set_name_label": "Keyword set name",
  "com_ui_keyword_set_name_required": "Enter a name for this keyword set.",
  "com_ui_keyword_set_import_apply": "Import & Apply",
  "com_ui_keyword_set_import_empty": "No valid terms were found in this file.",
  "com_ui_keyword_set_import_read_error": "Could not read this file.",
  "com_ui_keyword_set_saved": "Keyword set saved.",
  "com_ui_keyword_set_save_error": "Failed to save keyword set. A set with this name may already exist.",
  "com_ui_keyword_set_renamed": "Keyword set renamed.",
  "com_ui_keyword_set_deleted": "Keyword set deleted.",
  "com_ui_keyword_set_delete_error": "Failed to delete keyword set.",
  "com_ui_keyword_set_term_count": "{{0}} terms",
  "com_ui_keyword_set_rename": "Rename",
  "com_ui_keyword_set_delete": "Delete",
  "com_ui_keyword_set_delete_confirm": "Delete this keyword set?",
  "com_ui_keyword_set_apply": "Apply",
  "com_ui_keyword_set_apply_prompt": "Replace or merge with current keywords?",
  "com_ui_keyword_set_replace": "Replace",
  "com_ui_keyword_set_merge": "Merge",
```

Confirm the interpolation syntax (`{{0}}` vs `{0}`) matches what neighboring keys in this file actually use — `useLocalize`'s `{ 0: value }` call pattern seen in `TranscribeOptionsDialog.tsx` (e.g. `com_ui_transcribe_options_speakers_hint`) determines which placeholder syntax this file's i18n setup expects; copy that key's exact placeholder syntax rather than guessing.

- [ ] **Step 2: Commit**

```bash
git add client/src/locales/en/translation.json
git commit -m "feat(keyword-sets): add keyword set localization keys"
```

---

## Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full data-schemas test suite**

Run: `cd packages/data-schemas && npx jest`
Expected: all tests pass, including the new `keywordSet.spec.ts`.

- [ ] **Step 2: Run the full client test suite for the touched area**

Run: `cd client && npx jest AudioTranscriber`
Expected: all tests pass, including `parseKeywordFile.spec.ts`.

- [ ] **Step 3: Build data-provider and the whole project**

Run: `npm run build:data-provider && npm run build`
Expected: clean build, no TS errors.

- [ ] **Step 4: Lint**

Run: `npx eslint packages/data-schemas/src/schema/keywordSet.ts packages/data-schemas/src/models/keywordSet.ts packages/data-schemas/src/methods/keywordSet.ts packages/api/src/keywordSets/handlers.ts api/server/routes/keywordSets.js packages/data-provider/src/api-endpoints.ts packages/data-provider/src/types.ts packages/data-provider/src/data-service.ts packages/data-provider/src/keys.ts packages/data-provider/src/react-query/react-query-service.ts client/src/components/AudioTranscriber/KeywordSets.tsx client/src/components/AudioTranscriber/parseKeywordFile.ts client/src/components/AudioTranscriber/TranscribeOptionsDialog.tsx --fix`
Expected: no remaining errors/warnings.

- [ ] **Step 5: Manual smoke test**

Run: `npm run backend:dev` and `npm run frontend:dev`, then in the browser:
1. Start a transcription, open Transcription Options → step 2 (terms).
2. Click "Import keyword set", pick a `.txt` file with `Serious Fraud Office, Financial Intelligence Unit, , Proceeds of Crime, Financial Intelligence Unit,` as its content — confirm the preview shows exactly 3 terms, name defaults to the filename, "Import & Apply" adds them to the active list.
3. Refresh the page, reopen the dialog, open "Saved keyword sets" — confirm the set persisted and shows "3 terms".
4. Add a manual term via "Add a term", then click "Apply" on the saved set — confirm the Replace/Merge prompt appears; try both and confirm the active list updates accordingly.
5. Rename the set, delete it, confirm both actions update the popover list without a page reload.
6. Confirm the existing "Add a term" input, remove-term chips, and suggested-terms chips still work unchanged.

- [ ] **Step 6: Report**

Summarize in the final response: files changed, data model, UI changes, API changes, tests run and their results, assumptions (no `.txt` size cap requested beyond the 500-term/200-char defensive server cap; no duplicate/overwrite-from-active actions per spec §7's "if practical"), and that no migration is needed for existing users since `KeywordSet` is a brand-new, empty-by-default collection.

---

## Self-Review Notes (from writing this plan)

- **Spec coverage:** §1 (import→preview→name→save→apply) — Task 4+5+6. §2 (active vs. saved are distinct) — `termTags` never written back to `KeywordSet` except via explicit create/rename. §3/§14 (server-side, per-user, ownership-enforced) — Task 1+2, `req.user.id` scoping on every method call. §5 (parsing rules) — Task 4's test suite covers every listed case. §6 (confirmation UI) — `ImportKeywordSetDialog` preview + name step. §7 (list/preview/apply/rename/delete) — `KeywordSetMenu`/`KeywordSetRow`. §8 (replace vs merge) — `applyKeywordTerms` + row-level chooser. §9 (built-in flow untouched) — no changes to `commitTermDraft`/`addSuggestion`/`parseTermTags`. §11 (recovery without re-upload) — saved terms are stored server-side, not the file. §12 (duplicate name handling) — unique index + 409 + toast, no auto-suffixing. §13 (user-friendly errors) — every handler branch maps to a specific localized toast, no raw error text surfaced. §17 acceptance criteria — covered by Task 1/4 automated tests plus Task 8's manual pass.
- **Explicitly out of scope**, per the spec's own "if practical" / "keep the first implementation focused" allowances: duplicating a set, and updating/overwriting a saved set from the current active keywords. Both are one more mutation + one more button if requested later — not scaffolded here.
- **Type consistency checked:** `KeywordSetListItem` shape (`id/name/terms/createdAt/updatedAt`) is identical across Task 1's methods, Task 2's handler response bodies, and Task 3's `TKeywordSet` (with `Date` narrowed to `string` over JSON, matching how `TAgentApiKeyListItem` does the same for `AgentApiKeyListItem`). `applyKeywordTerms(terms, mode)` signature in Task 6 matches `KeywordSetMenu`'s `onApply` and `ImportKeywordSetDialog`'s `onApply` call sites exactly.
