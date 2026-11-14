import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  bootstrapFixture,
  conversationPayload,
  navigateConversation,
  openConversation,
} from "./conversation-bootstrap-fixture.ts";
import {
  act,
  cleanupInspectionDom,
  clearProductCache,
  currentAccessGeneration,
  fireEvent,
  installInspectionDom,
  waitFor,
} from "./inspection-ui-fixture.ts";

const fixtures: ReturnType<typeof bootstrapFixture>[] = [];
const fixture = (options: Parameters<typeof bootstrapFixture>[0] = {}) => {
  const server = bootstrapFixture(options);
  fixtures.push(server);
  return server;
};
beforeEach(() => {
  installInspectionDom();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
});
afterEach(() => {
  for (const server of fixtures.splice(0)) {
    server.disconnect();
  }
  cleanupInspectionDom();
});

test("a deep link resolves its bound agent and paints its full payload with one GET", async () => {
  const server = fixture();
  const view = server.mount("chat-b");
  await waitFor(() => assert.ok(view.getByText("chat-b")));
  await waitFor(() => assert.equal(server.observations.length, 1));
  assert.equal(server.reads("chat-b").length, 1);
  assert.ok(view.getByRole("heading", { name: "Agent B", exact: true }));
  assert.equal(
    server.calls.some(({ path }) => path.endsWith("/inspection")),
    false
  );
});

test("Open conversation reads the returned binding once and attaches observation", async () => {
  const server = fixture();
  const view = server.mount();
  await openConversation(view);
  await waitFor(() => assert.ok(view.getByText("chat-a")));
  await waitFor(() => assert.equal(server.observations.length, 1));
  assert.equal(server.reads("chat-a").length, 1);
  assert.equal(
    server.calls.filter(
      ({ path, method }) => path.endsWith("/conversations") && method === "POST"
    ).length,
    1
  );
});

test("sidebar selection resumes a saved conversation and leaves a new agent ready to open one", async () => {
  const server = fixture({ canManage: true, savedConversation: "chat-a" });
  const view = server.mount();
  await waitFor(() =>
    assert.ok(view.getByRole("button", { name: /Agent A/u }))
  );
  await act(() =>
    fireEvent.click(view.getByRole("button", { name: /Agent A/u }))
  );
  await waitFor(() => assert.ok(view.getByText("chat-a")));
  const composer = view.getByRole("textbox", { name: "Message" });
  await act(() => {
    fireEvent.change(composer, { target: { value: "Unsent sidebar draft" } });
    fireEvent.click(view.getByRole("button", { name: /Agent A/u }));
  });
  assert.equal(view.getByDisplayValue("Unsent sidebar draft"), composer);
  assert.equal(server.reads("chat-a").length, 1);
  await act(() =>
    fireEvent.click(
      view.getByRole("tab", { name: "Configuration", exact: true })
    )
  );
  assert.equal(view.queryByText("chat-a"), null);
  await act(() =>
    fireEvent.click(view.getByRole("button", { name: /Agent A/u }))
  );
  await waitFor(() => assert.ok(view.getByText("chat-a")));
  await act(() =>
    fireEvent.click(view.getByRole("button", { name: /Agent B/u }))
  );
  assert.ok(view.getByRole("heading", { name: "Agent B", exact: true }));
  assert.equal(view.queryByText("chat-a"), null);
  assert.ok(
    view.getByRole("button", { name: "Open conversation", exact: true })
  );
  assert.equal(
    server.calls.some(({ method }) => method === "POST"),
    false
  );
});

test("opening the live primary conversation preserves its draft, stream and newer snapshot", async () => {
  const server = fixture();
  const view = server.mount("chat-a");
  await waitFor(() => assert.equal(server.observations.length, 1));
  const composer = view.getByRole("textbox", { name: "Message" });
  await act(() => {
    fireEvent.change(composer, { target: { value: "Unsent draft" } });
    server.send("chat-a", "Newer observed answer");
  });
  await waitFor(() => assert.ok(view.getByText("Newer observed answer")));
  await openConversation(view);
  await waitFor(() =>
    assert.equal(
      view
        .getByRole("button", { name: "Open conversation", exact: true })
        .hasAttribute("disabled"),
      false
    )
  );
  assert.equal(view.getByRole("textbox", { name: "Message" }), composer);
  assert.equal(view.getByDisplayValue("Unsent draft"), composer);
  assert.ok(view.getByText("Newer observed answer"));
  assert.equal(view.queryByText("chat-a"), null);
  assert.equal(server.reads("chat-a").length, 1);
  assert.equal(server.observations.length, 1);
  assert.equal(server.observations[0]?.signal?.aborted, false);
});

test("leaving and reopening the same ID loads a fresh selection instead of a saved snapshot", async () => {
  let reads = 0;
  const server = fixture({
    read: (id) => {
      if (id === "chat-a") {
        reads += 1;
      }
      return Response.json(
        conversationPayload(
          id,
          id === "chat-a" ? `Answer A ${reads}` : "Answer B"
        )
      );
    },
  });
  const view = server.mount("chat-a");
  await waitFor(() => assert.ok(view.getByText("Answer A 1")));
  await navigateConversation(view, "B");
  await waitFor(() => assert.ok(view.getByText("Answer B")));
  assert.equal(view.queryByText("Answer A 1"), null);
  await navigateConversation(view, "A");
  await waitFor(() => assert.ok(view.getByText("Answer A 2")));
  assert.equal(view.queryByText("Answer A 1"), null);
  assert.equal(server.reads("chat-a").length, 2);
  assert.equal(server.reads("chat-b").length, 1);
});

for (const status of [200, 403]) {
  test(`a retired route's delayed ${status} response cannot paint or revoke the current chat`, async () => {
    const held = Promise.withResolvers<Response>();
    const server = fixture({
      read: (id) =>
        id === "chat-a" ? held.promise : Response.json(conversationPayload(id)),
    });
    const view = server.mount("chat-a");
    await waitFor(() => assert.equal(server.reads("chat-a").length, 1));
    const generation = currentAccessGeneration();
    await navigateConversation(view, "B");
    await waitFor(() => assert.ok(view.getByText("chat-b")));
    assert.equal(server.reads("chat-a")[0]?.signal?.aborted, true);
    await act(async () => {
      held.resolve(
        Response.json(
          status === 200
            ? conversationPayload("chat-a", "Private old route")
            : { message: "Old denial" },
          { status }
        )
      );
      await delay(0);
    });
    assert.ok(view.getByText("chat-b"));
    assert.equal(currentAccessGeneration(), generation);
    assert.equal(
      server.painted.some((text) => text.includes("Private old route")),
      false
    );
    assert.equal(server.observations.length, 1);
  });
}

test("changing actors retires a pending payload before the new actor's content paints", async () => {
  const held = Promise.withResolvers<Response>();
  let reads = 0;
  const server = fixture({
    read: (id) => {
      reads += 1;
      return reads === 1
        ? held.promise
        : Response.json(conversationPayload(id, "New actor answer"));
    },
  });
  const view = server.mount("chat-a");
  await waitFor(() => assert.equal(server.reads("chat-a").length, 1));
  await act(() => view.rerender(server.element("other-user", "chat-a")));
  await waitFor(() => assert.ok(view.getByText("New actor answer")));
  await act(async () => {
    held.resolve(
      Response.json(conversationPayload("chat-a", "Private prior actor"))
    );
    await delay(0);
  });
  assert.ok(view.getByText("New actor answer"));
  assert.equal(server.reads("chat-a")[0]?.signal?.aborted, true);
  assert.equal(
    server.painted.some((text) => text.includes("Private prior actor")),
    false
  );
  assert.equal(server.reads("chat-a").length, 2);
});

test("cleared access cannot be restored by a pending full response", async () => {
  const held = Promise.withResolvers<Response>();
  const server = fixture({ read: () => held.promise });
  const view = server.mount("chat-a");
  await waitFor(() => assert.equal(server.reads("chat-a").length, 1));
  await act(() => clearProductCache());
  await act(async () => {
    held.resolve(
      Response.json(conversationPayload("chat-a", "Private revoked answer"))
    );
    await delay(0);
  });
  assert.ok(
    view.getByText(
      "Access changed. Refresh the workspace to check your permissions."
    )
  );
  assert.equal(
    server.painted.some((text) => text.includes("Private revoked answer")),
    false
  );
  assert.equal(server.observations.length, 0);
});

test("clearing access after Open retires the payload without an automatic replacement read", async () => {
  const server = fixture();
  const view = server.mount();
  await openConversation(view);
  await waitFor(() => assert.ok(view.getByText("chat-a")));
  await act(() => clearProductCache());
  await act(async () => {
    await delay(0);
  });
  assert.ok(
    view.getByText(
      "Access changed. Refresh the workspace to check your permissions."
    )
  );
  assert.equal(view.queryByText("chat-a"), null);
  assert.equal(server.reads("chat-a").length, 1);
  assert.ok(server.observations.every(({ signal }) => signal?.aborted));
});

for (const tab of ["Configuration", "Access"]) {
  for (const status of [200, 403]) {
    test(`returning from ${tab} awaits a fresh ${status} read before private content paints`, async () => {
      const held = Promise.withResolvers<Response>();
      let reads = 0;
      const server = fixture({
        canManage: true,
        read: (id) => {
          reads += 1;
          return reads === 1
            ? Response.json(conversationPayload(id, "Prior tab answer"))
            : held.promise;
        },
      });
      const view = server.mount("chat-a");
      await waitFor(() => assert.ok(view.getByText("Prior tab answer")));
      await act(() =>
        fireEvent.click(view.getByRole("tab", { name: tab, exact: true }))
      );
      assert.equal(view.queryByText("Prior tab answer"), null);
      assert.ok(server.observations.every(({ signal }) => signal?.aborted));
      if (tab === "Access") {
        await waitFor(() => {
          assert.equal(
            view
              .getByRole("checkbox", { name: "read access for Team Member" })
              .getAttribute("aria-checked"),
            "true"
          );
          assert.equal(
            view
              .getByRole("checkbox", { name: "execute access for Team Member" })
              .getAttribute("aria-checked"),
            "false"
          );
        });
      }
      await act(() =>
        fireEvent.click(
          view.getByRole("tab", { name: "Conversation", exact: true })
        )
      );
      await waitFor(() => assert.equal(server.reads("chat-a").length, 2));
      assert.ok(view.getByText("Loading the agent for this conversation…"));
      assert.equal(view.queryByText("Prior tab answer"), null);
      assert.equal(server.observations.length, 1);
      const generation = currentAccessGeneration();
      await act(async () => {
        held.resolve(
          Response.json(
            status === 200
              ? conversationPayload("chat-a", "Fresh tab answer")
              : { message: "Tab access denied" },
            { status }
          )
        );
        await delay(0);
      });
      if (status === 200) {
        await waitFor(() => assert.ok(view.getByText("Fresh tab answer")));
        assert.equal(server.observations.length, 2);
      } else {
        assert.ok(
          view.getByText(
            "Access changed. Refresh the workspace to check your permissions."
          )
        );
        assert.equal(currentAccessGeneration(), generation + 1);
        assert.equal(view.queryByText("Fresh tab answer"), null);
      }
      assert.equal(view.queryByText("Prior tab answer"), null);
    });
  }
}

test("a current denial clears the prior private chat and advances access generation", async () => {
  const server = fixture({
    read: (id) =>
      id === "chat-a"
        ? Response.json(conversationPayload(id, "Private before denial"))
        : Response.json({ message: "Current denial" }, { status: 403 }),
  });
  const view = server.mount("chat-a");
  await waitFor(() => assert.ok(view.getByText("Private before denial")));
  const generation = currentAccessGeneration();
  await navigateConversation(view, "B");
  await waitFor(() =>
    assert.ok(
      view.getByText(
        "Access changed. Refresh the workspace to check your permissions."
      )
    )
  );
  assert.equal(view.queryByText("Private before denial"), null);
  assert.equal(currentAccessGeneration(), generation + 1);
  assert.ok(server.observations.every(({ signal }) => signal?.aborted));
});

test("an actor change clears loaded private content before its replacement response arrives", async () => {
  const held = Promise.withResolvers<Response>();
  let reads = 0;
  const server = fixture({
    read: (id) => {
      reads += 1;
      return reads === 1
        ? Response.json(conversationPayload(id, "Prior actor secret"))
        : held.promise;
    },
  });
  const view = server.mount("chat-a");
  await waitFor(() => assert.ok(view.getByText("Prior actor secret")));
  await act(() => view.rerender(server.element("other-user", "chat-a")));
  assert.equal(view.queryByText("Prior actor secret"), null);
  await waitFor(() => assert.equal(server.reads("chat-a").length, 2));
  await act(async () => {
    held.resolve(
      Response.json(conversationPayload("chat-a", "Replacement actor answer"))
    );
    await delay(0);
  });
  await waitFor(() => assert.ok(view.getByText("Replacement actor answer")));
  assert.equal(view.queryByText("Prior actor secret"), null);
  assert.equal(server.observations[0]?.signal?.aborted, true);
});

for (const status of [200, 403]) {
  test(`a delayed Open ${status} reply cannot navigate away from a newer agent selection`, async () => {
    const held = Promise.withResolvers<Response>();
    let opens = 0;
    const server = fixture({
      open: () => {
        opens += 1;
        return opens === 1
          ? held.promise
          : Response.json(conversationPayload("chat-b"));
      },
    });
    const view = server.mount();
    await openConversation(view);
    await waitFor(() => assert.equal(opens, 1));
    const generation = currentAccessGeneration();
    await act(() =>
      fireEvent.click(view.getByRole("button", { name: /Agent B/u }))
    );
    await openConversation(view);
    await waitFor(() => assert.ok(view.getByText("chat-b")));
    await act(async () => {
      held.resolve(
        Response.json(
          status === 200
            ? conversationPayload("chat-a")
            : { message: "Old denial" },
          { status }
        )
      );
      await delay(0);
    });
    assert.ok(view.getByText("chat-b"));
    assert.equal(server.reads("chat-a").length, 0);
    assert.equal(server.reads("chat-b").length, 1);
    assert.equal(currentAccessGeneration(), generation);
  });
}

for (const mismatch of [
  "outer-conversation",
  "inner-agent",
  "inner-session",
  "organization",
  "invalid-snapshot",
] as const) {
  test(`a ${mismatch} response is rejected before its private content can paint`, async () => {
    const payload = conversationPayload("chat-a", "Private mismatched answer");
    const address = { ...payload.snapshot.address };
    const invalid = {
      ...payload,
      conversationId:
        mismatch === "outer-conversation"
          ? "another-chat"
          : payload.conversationId,
      snapshot: {
        ...payload.snapshot,
        address: {
          ...address,
          agentId:
            mismatch === "inner-agent" ? "another-agent" : address.agentId,
          sessionId:
            mismatch === "inner-session"
              ? "another-session"
              : address.sessionId,
          organizationId:
            mismatch === "organization"
              ? "another-company"
              : address.organizationId,
        },
        messages:
          mismatch === "invalid-snapshot"
            ? "invalid"
            : payload.snapshot.messages,
      },
    };
    const server = fixture({
      read: (id) =>
        Response.json(id === "chat-a" ? invalid : conversationPayload(id)),
    });
    const view = server.mount("chat-a");
    await waitFor(() => assert.ok(view.getByRole("alert")));
    assert.equal(server.observations.length, 0);
    await navigateConversation(view, "B");
    await waitFor(() => assert.ok(view.getByText("chat-b")));
    assert.equal(
      server.painted.some((text) => text.includes("Private mismatched answer")),
      false
    );
  });
}

test("an Open binding rejects a coherently wrong session before any content paints", async () => {
  const payload = conversationPayload("chat-a", "Wrong opened session");
  const server = fixture({
    read: (id) =>
      Response.json(
        id === "chat-a"
          ? {
              ...payload,
              sessionId: "wrong-session",
              snapshot: {
                ...payload.snapshot,
                address: {
                  ...payload.snapshot.address,
                  sessionId: "wrong-session",
                },
              },
            }
          : conversationPayload(id)
      ),
  });
  const view = server.mount();
  await openConversation(view);
  await waitFor(() =>
    assert.ok(view.getByText("The conversation does not belong to this agent."))
  );
  assert.equal(server.observations.length, 0);
  await navigateConversation(view, "B");
  await waitFor(() => assert.ok(view.getByText("chat-b")));
  assert.equal(
    server.painted.some((text) => text.includes("Wrong opened session")),
    false
  );
});

test("Open rejects a binding for a different agent before any full GET or navigation", async () => {
  const server = fixture({
    open: () => Response.json(conversationPayload("chat-b")),
  });
  const view = server.mount();
  await openConversation(view);
  await waitFor(() =>
    assert.ok(view.getByText("The conversation does not belong to this agent."))
  );
  assert.equal(server.reads("chat-b").length, 0);
  assert.equal(server.observations.length, 0);
  await act(() =>
    fireEvent.click(view.getByRole("button", { name: /Agent B/u }))
  );
  await openConversation(view);
  await waitFor(() => assert.ok(view.getByText("chat-b")));
  assert.equal(server.reads("chat-b").length, 1);
});

for (const from of ["Configuration", "Access"]) {
  const to = from === "Configuration" ? "Access" : "Configuration";
  for (const status of [200, 403]) {
    test(`a delayed Open ${status} reply cannot replace ${to} after leaving ${from}`, async () => {
      const held = Promise.withResolvers<Response>();
      let opens = 0;
      const server = fixture({
        canManage: true,
        open: () => {
          opens += 1;
          return opens === 1
            ? held.promise
            : Response.json(conversationPayload("chat-a"));
        },
      });
      const view = server.mount();
      const fromTab = await waitFor(() =>
        view.getByRole("tab", { name: from, exact: true })
      );
      assert.equal(fromTab.hasAttribute("disabled"), false);
      await act(() => fireEvent.click(fromTab));
      assert.equal(fromTab.getAttribute("aria-selected"), "true");
      await openConversation(view);
      await waitFor(() => assert.equal(opens, 1));
      const pending = server.calls.find(
        ({ method, path }) =>
          method === "POST" && path.endsWith("/conversations")
      );
      assert.ok(pending);
      const generation = currentAccessGeneration();
      await act(() =>
        fireEvent.click(view.getByRole("tab", { name: to, exact: true }))
      );
      await act(async () => {
        held.resolve(
          Response.json(
            status === 200
              ? conversationPayload("chat-a")
              : { message: "Retired view denial" },
            { status }
          )
        );
        await delay(0);
      });
      assert.equal(
        view
          .getByRole("tab", { name: to, exact: true })
          .getAttribute("aria-selected"),
        "true"
      );
      assert.equal(currentAccessGeneration(), generation);
      assert.equal(pending.signal?.aborted, true);
      assert.equal(server.reads("chat-a").length, 0);
      assert.equal(server.observations.length, 0);
      await openConversation(view);
      await waitFor(() => assert.ok(view.getByText("chat-a")));
      assert.equal(server.reads("chat-a").length, 1);
      assert.equal(server.observations.length, 1);
    });
  }
}
