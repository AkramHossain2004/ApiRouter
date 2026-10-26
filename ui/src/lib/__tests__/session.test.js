import { beforeEach, describe, expect, it } from "vitest";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k)
  };
}

async function load() {
  return import("../session.js");
}

describe("router token persistence", () => {
  beforeEach(() => {
    globalThis.window = { localStorage: memoryStorage(), sessionStorage: memoryStorage() };
  });

  it("persists the token in localStorage so a new tab is still logged in", async () => {
    const { setRouterToken, getRouterToken } = await load();
    setRouterToken("  secret-key  ");
    expect(window.localStorage.getItem("apirouter.routerToken")).toBe("secret-key");

    // A new tab has an empty sessionStorage but shares localStorage.
    window.sessionStorage = memoryStorage();
    expect(getRouterToken()).toBe("secret-key");
  });

  it("migrates a token left in sessionStorage by the old behaviour", async () => {
    const { getRouterToken } = await load();
    window.sessionStorage.setItem("apirouter.routerToken", "old-key");
    expect(getRouterToken()).toBe("old-key");
    expect(window.localStorage.getItem("apirouter.routerToken")).toBe("old-key");
    expect(window.sessionStorage.getItem("apirouter.routerToken")).toBeNull();
  });

  it("logs out by clearing the token everywhere", async () => {
    const { setRouterToken, getRouterToken } = await load();
    setRouterToken("secret-key");
    setRouterToken("");
    expect(getRouterToken()).toBe("");
    expect(window.localStorage.getItem("apirouter.routerToken")).toBeNull();
  });

  it("falls back to the tab session when localStorage is blocked", async () => {
    const { setRouterToken, getRouterToken } = await load();
    window.localStorage = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); }
    };
    setRouterToken("secret-key");
    expect(getRouterToken()).toBe("secret-key");
  });
});
