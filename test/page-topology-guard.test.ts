import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { BrowserContext, Page } from "playwright-core";

import {
  PAGE_TOPOLOGY_INVALID,
  startExactPageTopologyGuard
} from "../src/runner/page-topology-guard.js";

class FakePage extends EventEmitter {
  closed = false;

  constructor(readonly owner: FakeContext) {
    super();
  }

  context(): FakeContext {
    return this.owner;
  }

  isClosed(): boolean {
    return this.closed;
  }

  asPage(): Page {
    return this as unknown as Page;
  }
}

class FakeContext extends EventEmitter {
  closed = false;
  readonly openPages: FakePage[] = [];
  onPages: (() => void) | undefined;
  pagesCalls = 0;

  pages(): Page[] {
    this.pagesCalls += 1;
    this.onPages?.();
    return [...this.openPages] as unknown as Page[];
  }

  isClosed(): boolean {
    return this.closed;
  }

  addPage(emit = true): FakePage {
    const page = new FakePage(this);
    this.openPages.push(page);
    if (emit) this.emit("page", page);
    return page;
  }

  closePage(page: FakePage): void {
    if (page.closed) return;
    page.closed = true;
    const index = this.openPages.indexOf(page);
    if (index >= 0) this.openPages.splice(index, 1);
    page.emit("close", page);
  }

  asContext(): BrowserContext {
    return this as unknown as BrowserContext;
  }
}

function fixture(): { context: FakeContext; page: FakePage } {
  const context = new FakeContext();
  const page = context.addPage(false);
  return { context, page };
}

test("guard permits same-page navigation and disposes listeners idempotently", () => {
  const current = fixture();
  const guard = startExactPageTopologyGuard(current.page.asPage());
  assert.equal(guard.recheck(), true);
  current.page.emit("framenavigated");
  assert.equal(guard.recheck(), true);
  guard.dispose();
  guard.dispose();
  assert.equal(current.context.listenerCount("page"), 0);
  assert.equal(current.context.listenerCount("close"), 0);
  assert.equal(current.page.listenerCount("close"), 0);
  assert.throws(() => guard.assertValid(), new RegExp(PAGE_TOPOLOGY_INVALID));
  const extra = current.context.addPage();
  current.context.closePage(extra);
  assert.equal(guard.signal.aborted, false, "disposed guard no longer observes later user activity");
});

test("replacement page identity is rejected even when the context emits no page event", () => {
  const current = fixture();
  const guard = startExactPageTopologyGuard(current.page.asPage());
  const replacement = new FakePage(current.context);
  current.context.openPages[0] = replacement;
  assert.equal(guard.recheck(), false);
  assert.equal(guard.signal.aborted, true);
  guard.dispose();
});

test("popup which opens and closes immediately remains a sticky violation", () => {
  const current = fixture();
  const guard = startExactPageTopologyGuard(current.page.asPage());
  const popup = current.context.addPage();
  current.context.closePage(popup);
  assert.equal(current.context.pages().length, 1);
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.recheck(), false);
  assert.throws(() => guard.assertValid(), new RegExp(PAGE_TOPOLOGY_INVALID));
  guard.dispose();
});

test("canonical page close and context close are both sticky", () => {
  for (const kind of ["page", "context"] as const) {
    const current = fixture();
    const guard = startExactPageTopologyGuard(current.page.asPage());
    if (kind === "page") {
      current.context.closePage(current.page);
    } else {
      current.context.closed = true;
      current.context.emit("close", current.context);
    }
    assert.equal(guard.signal.aborted, true);
    assert.equal(guard.recheck(), false);
    guard.dispose();
  }
});

test("listener-first snapshot catches a transient extra page during initial recheck", () => {
  const current = fixture();
  let transient: FakePage | undefined;
  current.context.onPages = () => {
    if (transient !== undefined) return;
    transient = current.context.addPage();
    current.context.closePage(transient);
  };
  assert.throws(
    () => startExactPageTopologyGuard(current.page.asPage()),
    new RegExp(PAGE_TOPOLOGY_INVALID)
  );
  assert.equal(current.context.listenerCount("page"), 0);
  assert.equal(current.page.listenerCount("close"), 0);
});

test("pre-existing extra page is rejected without choosing or closing it", () => {
  const current = fixture();
  const extra = current.context.addPage(false);
  assert.throws(
    () => startExactPageTopologyGuard(current.page.asPage()),
    new RegExp(PAGE_TOPOLOGY_INVALID)
  );
  assert.equal(extra.closed, false);
  assert.deepEqual(current.context.openPages, [current.page, extra]);
});
