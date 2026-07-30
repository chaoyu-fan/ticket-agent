import assert from "node:assert/strict";
import test from "node:test";

import type { Page } from "playwright-core";

import {
  DEFAULT_DOM_FALLBACK_INTERVAL_MS,
  waitForDomPredicate
} from "../src/runner/dom-event.js";

interface FakeStyle {
  display: string;
  visibility: string;
  opacity: string;
}

class FakeElement {
  readonly ownerDocument: Document;
  isConnected = true;
  hidden = false;
  rectCount = 1;
  readonly attributes = new Map<string, string>();
  readonly style: FakeStyle = { display: "block", visibility: "visible", opacity: "1" };
  readonly secretText = "身份证号不应返回";

  constructor(document: FakeDocument) {
    this.ownerDocument = document as unknown as Document;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  getClientRects(): DOMRectList {
    return { length: this.rectCount } as DOMRectList;
  }
}

class FakeRoot {
  constructor(readonly document: FakeDocument) {}
}

class FakeDocument {
  readonly documentElement = new FakeRoot(this);
  readonly observers = new Set<FakeMutationObserver>();
  readonly defaultView = {
    getComputedStyle: (element: Element): CSSStyleDeclaration =>
      (element as unknown as FakeElement).style as unknown as CSSStyleDeclaration
  };
  private readonly elements = new Map<string, FakeElement[]>();

  querySelectorAll(selector: string): NodeListOf<Element> {
    if (selector === "[") throw new Error("invalid selector with sensitive browser detail");
    return [...(this.elements.get(selector) ?? [])] as unknown as NodeListOf<Element>;
  }

  set(selector: string, elements: FakeElement[], notify = true): void {
    this.elements.set(selector, elements);
    if (notify) queueMicrotask(() => this.notify());
  }

  notify(): void {
    for (const observer of [...this.observers]) observer.notify();
  }
}

class FakeMutationObserver {
  private document: FakeDocument | undefined;

  constructor(private readonly callback: MutationCallback) {}

  observe(target: Node): void {
    const root = target as unknown as FakeRoot;
    this.document = root.document;
    this.document.observers.add(this);
  }

  disconnect(): void {
    this.document?.observers.delete(this);
    this.document = undefined;
  }

  notify(): void {
    this.callback([], this as unknown as MutationObserver);
  }
}

class InProcessPage {
  readonly inputs: unknown[] = [];

  async evaluate(pageFunction: unknown, argument: unknown): Promise<unknown> {
    this.inputs.push(argument);
    if (typeof pageFunction !== "function") throw new Error("expected an evaluate function");
    // Playwright serializes page functions instead of preserving their Node
    // lexical closure. Reconstructing the function catches accidental outer
    // references such as a module-level registry-name constant.
    const reconstructed = Function(`"use strict"; return (${pageFunction.toString()});`)() as
      (value: unknown) => unknown;
    return reconstructed(argument);
  }

  asPage(): Pick<Page, "evaluate"> {
    return this as unknown as Pick<Page, "evaluate">;
  }
}

class DelayedFirstEvaluatePage extends InProcessPage {
  private calls = 0;

  override async evaluate(pageFunction: unknown, argument: unknown): Promise<unknown> {
    this.calls += 1;
    if (this.calls === 1) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    return super.evaluate(pageFunction, argument);
  }
}

function restoreProperty(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
  else Object.defineProperty(globalThis, name, descriptor);
}

async function withFakeDom(run: (document: FakeDocument, page: InProcessPage) => Promise<void>): Promise<void> {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");
  const registryDescriptor = Object.getOwnPropertyDescriptor(globalThis, "__ticketAgentVisibleDomWaiters_v1");
  const document = new FakeDocument();
  const page = new InProcessPage();
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: FakeMutationObserver });
  try {
    await run(document, page);
  } finally {
    restoreProperty("document", documentDescriptor);
    restoreProperty("MutationObserver", observerDescriptor);
    restoreProperty("__ticketAgentVisibleDomWaiters_v1", registryDescriptor);
  }
}

test("serialized page.evaluate callback has no Node closure dependency and returns no page text", async () => {
  await withFakeDom(async (document, page) => {
    document.set("[data-ready]", [new FakeElement(document)], false);
    const result = await waitForDomPredicate(page.asPage(), {
      predicates: [{ key: "purchase-ready", selector: "[data-ready]" }],
      timeoutMs: 500
    });

    assert.equal(result.outcome, "matched");
    if (result.outcome !== "matched") return;
    assert.equal(result.key, "purchase-ready");
    assert.equal(result.visibility, "visible");
    assert.equal(result.source, "initial");
    assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
    assert.doesNotMatch(JSON.stringify(result), /身份证/);
    assert.equal(document.observers.size, 0);
  });
});

test("MutationObserver wins when a matching element becomes visible", async () => {
  await withFakeDom(async (document, page) => {
    const element = new FakeElement(document);
    element.style.display = "none";
    document.set("[data-ready]", [element], false);

    const waiting = waitForDomPredicate(page.asPage(), {
      predicates: [{ key: "purchase-ready", selector: "[data-ready]" }],
      timeoutMs: 500
    });
    setTimeout(() => {
      element.style.display = "block";
      document.notify();
    }, 15);

    const result = await waiting;
    assert.equal(result.outcome, "matched");
    if (result.outcome !== "matched") return;
    assert.equal(result.source, "mutation");
    assert.equal(result.key, "purchase-ready");
    assert.ok(result.latencyMs >= 0);
    assert.equal(document.observers.size, 0);
  });
});

test("default frame fallback detects a change that emitted no observed mutation", async () => {
  await withFakeDom(async (document, page) => {
    const queue = new FakeElement(document);
    document.set("[data-queue]", [queue], false);
    const waiting = waitForDomPredicate(page.asPage(), {
      predicates: [{ key: "queue-gone", selector: "[data-queue]", visibility: "hidden" }],
      timeoutMs: 500
    });
    // Keep the queue visible for the initial scan, then change the fake DOM
    // without notifying observers so only the fallback can detect it.
    setTimeout(() => document.set("[data-queue]", [], false), 15);

    const result = await waiting;
    assert.equal(result.outcome, "matched");
    if (result.outcome !== "matched") return;
    assert.equal(result.key, "queue-gone");
    assert.equal(result.visibility, "hidden");
    assert.equal(result.source, "fallback");
    const firstInput = page.inputs[0] as { fallbackIntervalMs?: number };
    assert.equal(firstInput.fallbackIntervalMs, DEFAULT_DOM_FALLBACK_INTERVAL_MS);
    assert.ok(result.latencyMs >= 10 && result.latencyMs < 400);
  });
});

test("timeout returns a monotonic latency and releases the observer", async () => {
  await withFakeDom(async (document, page) => {
    const result = await waitForDomPredicate(page.asPage(), {
      predicates: [{ key: "never", selector: "[data-never]" }],
      timeoutMs: 25,
      fallbackIntervalMs: 10
    });
    assert.equal(result.outcome, "timeout");
    assert.equal(result.source, "timeout");
    assert.ok(result.latencyMs >= 15 && result.latencyMs < 300);
    assert.equal(document.observers.size, 0);
  });
});

test("AbortSignal returns promptly and cancels the page-side waiter", async () => {
  await withFakeDom(async (document, page) => {
    const controller = new AbortController();
    const waiting = waitForDomPredicate(page.asPage(), {
      predicates: [{ key: "never", selector: "[data-never]" }],
      timeoutMs: 1_000,
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 15);

    const result = await waiting;
    assert.equal(result.outcome, "aborted");
    assert.equal(result.source, "abort");
    assert.ok(result.latencyMs < 300);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(document.observers.size, 0);
    assert.equal(page.inputs.length, 2);
  });
});

test("abort racing waiter installation leaves no pre-registration observer", async () => {
  await withFakeDom(async (document, _unusedPage) => {
    const page = new DelayedFirstEvaluatePage();
    const controller = new AbortController();
    const waiting = waitForDomPredicate(page.asPage(), {
      predicates: [{ key: "never", selector: "[data-never]" }],
      timeoutMs: 1_000,
      signal: controller.signal
    });
    controller.abort();
    const result = await waiting;
    assert.equal(result.outcome, "aborted");
    assert.equal(document.observers.size, 0);
    assert.equal(page.inputs.length, 2);
  });
});

test("an already-aborted signal does not install a page waiter", async () => {
  await withFakeDom(async (_document, page) => {
    const controller = new AbortController();
    controller.abort();
    const result = await waitForDomPredicate(page.asPage(), {
      predicates: [{ key: "never", selector: "[data-never]" }],
      timeoutMs: 100,
      signal: controller.signal
    });
    assert.equal(result.outcome, "aborted");
    assert.equal(page.inputs.length, 0);
  });
});

test("rejects unsafe or ambiguous predicate configuration", async () => {
  await withFakeDom(async (_document, page) => {
    await assert.rejects(
      () => waitForDomPredicate(page.asPage(), { predicates: [], timeoutMs: 100 }),
      /DOM_WAIT_PREDICATES_REQUIRED/
    );
    await assert.rejects(
      () => waitForDomPredicate(page.asPage(), {
        predicates: [
          { key: "same", selector: "[data-one]" },
          { key: "same", selector: "[data-two]" }
        ],
        timeoutMs: 100
      }),
      /DOM_WAIT_KEY_DUPLICATE/
    );
    await assert.rejects(
      () => waitForDomPredicate(page.asPage(), {
        predicates: [{ key: "bad-selector", selector: "[" }],
        timeoutMs: 100
      }),
      /DOM_WAIT_SELECTOR_INVALID:bad-selector/
    );
    assert.equal(page.inputs.length, 1);
  });
});
