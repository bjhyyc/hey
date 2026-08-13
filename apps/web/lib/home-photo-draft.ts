import { emptyPhotoSlots, type PetSpecies, type PhotoFileSlots } from "./photo-slots";

export const HOME_DRAFT_DATABASE = "petpack-studio-local-drafts";
export const HOME_DRAFT_STORE = "photo-drafts";
export const HOME_DRAFT_KEY = "home-selection";
export const HOME_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

type StoredPhoto = {
  blob: Blob;
  lastModified: number;
  name: string;
  type: string;
};

type StoredHomeDraft = {
  id: typeof HOME_DRAFT_KEY;
  createdAt: number;
  species: PetSpecies;
  photos: Array<StoredPhoto | null>;
};

export type HomePhotoDraft = {
  species: PetSpecies;
  photos: PhotoFileSlots;
};

function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(HOME_DRAFT_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(HOME_DRAFT_STORE)) {
        request.result.createObjectStore(HOME_DRAFT_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法保存照片"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("无法保存照片"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("无法保存照片"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法读取照片"));
  });
}

export async function saveHomePhotoDraft(
  photos: PhotoFileSlots,
  species: PetSpecies,
): Promise<void> {
  const count = photos.filter(Boolean).length;
  if (count < 1 || count > 4) {
    throw new Error("首页草稿只能保存一至四张照片");
  }

  const database = await openDraftDatabase();
  try {
    const transaction = database.transaction(HOME_DRAFT_STORE, "readwrite");
    const done = transactionDone(transaction);
    const storedPhotos = photos.map((file): StoredPhoto | null =>
      file
        ? {
            blob: file.slice(0, file.size, file.type),
            lastModified: file.lastModified,
            name: file.name,
            type: file.type,
          }
        : null,
    );
    transaction.objectStore(HOME_DRAFT_STORE).put({
      id: HOME_DRAFT_KEY,
      createdAt: Date.now(),
      species,
      photos: storedPhotos,
    } satisfies StoredHomeDraft);
    await done;
  } finally {
    database.close();
  }
}

export async function loadHomePhotoDraft(): Promise<HomePhotoDraft | null> {
  const database = await openDraftDatabase();
  let shouldClear = false;
  let result: HomePhotoDraft | null = null;
  try {
    const transaction = database.transaction(HOME_DRAFT_STORE, "readonly");
    const done = transactionDone(transaction);
    const record = await requestResult(
      transaction.objectStore(HOME_DRAFT_STORE).get(HOME_DRAFT_KEY),
    ) as StoredHomeDraft | undefined;
    await done;

    if (
      record &&
      (Date.now() - record.createdAt > HOME_DRAFT_TTL_MS ||
        !Array.isArray(record.photos) ||
        record.photos.length < 1 ||
        record.photos.length > 4)
    ) {
      shouldClear = true;
    } else if (record) {
      const photos = emptyPhotoSlots();
      for (let index = 0; index < 4; index += 1) {
        const stored = record.photos[index];
        photos[index] = stored
          ? new File([stored.blob], stored.name, {
              lastModified: stored.lastModified,
              type: stored.type,
            })
          : null;
      }
      if (photos.some(Boolean)) {
        result = {
          photos,
          species: record.species === "cat" ? "cat" : "dog",
        };
      } else {
        shouldClear = true;
      }
    }
  } finally {
    database.close();
  }

  if (shouldClear) await clearHomePhotoDraft().catch(() => undefined);
  return result;
}

export async function clearHomePhotoDraft(): Promise<void> {
  const database = await openDraftDatabase();
  try {
    const transaction = database.transaction(HOME_DRAFT_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(HOME_DRAFT_STORE).delete(HOME_DRAFT_KEY);
    await done;
  } finally {
    database.close();
  }
}
