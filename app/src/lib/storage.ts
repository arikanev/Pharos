/**
 * Tiny IndexedDB-backed cache for the *current* trip.
 *
 * MVP scope: one trip slot, key = "current". Save the route + beacons +
 * tune output after planning so the live nav loop continues working even
 * if the network drops mid-walk.
 *
 * Falls back to localStorage on platforms without IDB (very rare today;
 * only really matters for SSR / unit tests).
 */

import type { LonLat } from "./beacon";
import type { TuneResult } from "./beacon";
import type { RouteResult } from "./routing";

export interface Trip {
  savedAt: number;
  start: LonLat;
  end: LonLat;
  startLabel?: string;
  endLabel?: string;
  driftBudgetFt: number;
  route: RouteResult;
  tune: TuneResult;
}

const DB_NAME = "pharos";
const DB_VERSION = 1;
const STORE = "trips";
const CURRENT_KEY = "current";
const LS_KEY = "pharos.trip.current";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB not available"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveCurrentTrip(trip: Trip): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(trip, CURRENT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LS_KEY, JSON.stringify(trip));
    }
  }
}

export async function loadCurrentTrip(): Promise<Trip | null> {
  try {
    const db = await openDb();
    return await new Promise<Trip | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(CURRENT_KEY);
      req.onsuccess = () => resolve((req.result as Trip | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Trip) : null;
  }
}

export async function clearCurrentTrip(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(CURRENT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    if (typeof localStorage !== "undefined") localStorage.removeItem(LS_KEY);
  }
}
