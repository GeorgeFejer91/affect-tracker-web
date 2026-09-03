import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryKeyValueStorage,
  STUDY_DRAFT_PROTOCOL,
  STUDY_PUBLICATION_PROTOCOL,
  StudyDraftStore,
  StudyStorageConflictError,
  StudyStorageQuotaError,
  StudyStorageValidationError,
} from "../site/src/study/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function definition(title = "Study one") {
  return {
    schema: "affect-tracker-study-definition",
    version: 1,
    studyId: "study-1",
    revision: title === "Study one" ? 1 : 2,
    title,
    sections: [],
  };
}

function createStore(options = {}) {
  let tick = 0;
  return new StudyDraftStore({
    storage: options.storage ?? new MemoryKeyValueStorage(),
    canonicalHash: options.canonicalHash ?? (async () => HASH_A),
    now: options.now ?? (() => new Date(1_700_000_000_000 + tick++ * 1000)),
    maxStudyDefinitionBytes: options.maxStudyDefinitionBytes,
  });
}

test("study drafts use versioned revisions and optimistic concurrency", () => {
  const store = createStore();
  const first = store.saveDraft({
    studyId: "study-1",
    studyDefinition: definition(),
    expectedRevision: 0,
  });
  assert.equal(first.protocol, STUDY_DRAFT_PROTOCOL);
  assert.equal(first.version, 1);
  assert.equal(first.revision, 1);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.studyDefinition));

  const second = store.saveDraft({
    studyId: "study-1",
    studyDefinition: definition("Revised study"),
    expectedRevision: 1,
  });
  assert.equal(second.revision, 2);
  assert.equal(second.createdAt, first.createdAt);
  assert.notEqual(second.updatedAt, first.updatedAt);
  assert.equal(store.getDraft("study-1").studyDefinition.title, "Revised study");
  assert.throws(() => store.saveDraft({
    studyId: "study-1",
    studyDefinition: definition("Stale writer"),
    expectedRevision: 1,
  }), StudyStorageConflictError);
});

test("publishing delegates canonical hashing and stores immutable snapshots", async () => {
  const hashInputs = [];
  const store = createStore({
    canonicalHash: async (value) => {
      assert.ok(Object.isFrozen(value));
      assert.ok(Object.isFrozen(value.sections));
      hashInputs.push(value);
      return hashInputs.length === 1 ? HASH_A : HASH_B;
    },
  });
  store.saveDraft({ studyId: "study-1", studyDefinition: definition(), expectedRevision: 0 });
  const publicationOne = await store.publishDraft("study-1", { expectedRevision: 1 });
  assert.equal(publicationOne.protocol, STUDY_PUBLICATION_PROTOCOL);
  assert.equal(publicationOne.protocolHash, HASH_A);
  assert.equal(publicationOne.studyDefinition.protocolHash, HASH_A);
  assert.equal(publicationOne.revision, 1);
  assert.ok(Object.isFrozen(publicationOne.studyDefinition));
  assert.throws(() => { publicationOne.studyDefinition.title = "Mutated"; }, TypeError);

  store.saveDraft({
    studyId: "study-1",
    studyDefinition: definition("Second protocol"),
    expectedRevision: 1,
  });
  const publicationTwo = await store.publishDraft("study-1", { expectedRevision: 2 });
  assert.equal(publicationTwo.protocolHash, HASH_B);
  assert.equal(publicationTwo.studyDefinition.protocolHash, HASH_B);
  assert.equal(publicationTwo.revision, 2);
  assert.equal(store.getPublication("study-1", 1).studyDefinition.title, "Study one");
  assert.deepEqual(store.listPublications("study-1").map((item) => item.revision), [1, 2]);
});

test("publishing the same revision is idempotent but rejects changed immutable bytes", async () => {
  const storage = new MemoryKeyValueStorage();
  const store = createStore({ storage });
  store.saveDraft({ studyId: "study-1", studyDefinition: definition(), expectedRevision: 0 });
  const first = await store.publishDraft("study-1");
  const repeated = await store.publishDraft("study-1");
  assert.deepEqual(repeated, first);

  const publicationKey = storage.key(1);
  const tampered = JSON.parse(storage.getItem(publicationKey));
  tampered.studyDefinition.title = "Changed outside authority";
  storage.setItem(publicationKey, JSON.stringify(tampered));
  await assert.rejects(store.publishDraft("study-1"), StudyStorageConflictError);
});

test("draft deletion never removes published snapshots", async () => {
  const store = createStore();
  store.saveDraft({ studyId: "study-2", studyDefinition: { title: "Two" }, expectedRevision: 0 });
  store.saveDraft({ studyId: "study-1", studyDefinition: definition(), expectedRevision: 0 });
  await store.publishDraft("study-1");
  assert.deepEqual(store.listDrafts().map((draft) => draft.studyId), ["study-1", "study-2"]);
  assert.equal(store.deleteDraft("study-1", { expectedRevision: 1 }), true);
  assert.equal(store.getDraft("study-1"), undefined);
  assert.equal(store.getPublication("study-1", 1).protocolHash, HASH_A);
  assert.equal(store.deleteDraft("study-1"), false);
  const resumed = store.saveDraft({
    studyId: "study-1",
    studyDefinition: definition("After publication"),
    expectedRevision: 1,
  });
  assert.equal(resumed.revision, 2, "published protocol revisions must never be reused");
});

test("draft boundaries reject unsafe IDs, non-JSON values, oversized data, and invalid hashes", async () => {
  const store = createStore({
    canonicalHash: async () => "not-a-digest",
    maxStudyDefinitionBytes: 128,
  });
  assert.throws(() => store.saveDraft({ studyId: "../study", studyDefinition: {} }), StudyStorageValidationError);
  assert.throws(() => store.saveDraft({
    studyId: "study-1",
    studyDefinition: { value: Number.NaN },
  }), /finite JSON number/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => store.saveDraft({ studyId: "study-1", studyDefinition: cyclic }), /cyclic/);
  assert.throws(() => store.saveDraft({
    studyId: "study-1",
    studyDefinition: { title: "x".repeat(200) },
  }), /limit/);

  const hashStore = createStore({ canonicalHash: async () => "not-a-digest" });
  hashStore.saveDraft({ studyId: "study-1", studyDefinition: definition() });
  await assert.rejects(hashStore.publishDraft("study-1"), /64-character SHA-256/);
});

test("local quota failure leaves the prior draft revision intact", () => {
  const storage = new MemoryKeyValueStorage({ maxBytes: 2_000 });
  const store = createStore({ storage, maxStudyDefinitionBytes: 10_000 });
  store.saveDraft({ studyId: "study-1", studyDefinition: definition(), expectedRevision: 0 });
  assert.throws(() => store.saveDraft({
    studyId: "study-1",
    studyDefinition: { title: "x".repeat(5_000) },
    expectedRevision: 1,
  }), StudyStorageQuotaError);
  const recovered = store.getDraft("study-1");
  assert.equal(recovered.revision, 1);
  assert.equal(recovered.studyDefinition.title, "Study one");
});

test("corrupted local records fail closed", () => {
  const storage = new MemoryKeyValueStorage();
  const store = createStore({ storage });
  store.saveDraft({ studyId: "study-1", studyDefinition: definition() });
  const key = storage.key(0);
  const record = JSON.parse(storage.getItem(key));
  record.unexpected = true;
  storage.setItem(key, JSON.stringify(record));
  assert.throws(() => store.getDraft("study-1"), /unsupported record shape/);
});
