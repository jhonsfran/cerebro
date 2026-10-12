import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@cerebro/ui/components/input-group";
import { JSDOM } from "jsdom";
import { createElement } from "react";

import { AuthFormField } from "../src/components/auth-form-field";

const globalNames = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Event",
  "IS_REACT_ACT_ENVIRONMENT",
];
const originalGlobals = globalNames.map((name) => ({
  descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  name,
}));
let dom;
const installDom = () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const name of globalNames) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
      writable: true,
    });
  }
};
installDom();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
dom.window.close();
beforeEach(installDom);
afterEach(() => {
  cleanup();
  dom.window.close();
  for (const { descriptor, name } of originalGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
});

test.each([
  { label: "Name", name: "name", type: undefined },
  { label: "Email", name: "email", type: "email" },
  { label: "Password", name: "password", type: "password" },
])(
  "auth field preserves labels, values, events, and errors for $name",
  (field) => {
    const changes = [];
    let blurCount = 0;
    const props = {
      ...field,
      errors: [{ message: "Invalid value" }],
      onBlur: () => {
        blurCount += 1;
      },
      onChange: (value) => changes.push(value),
      value: "initial",
    };
    const view = render(createElement(AuthFormField, props));
    const input = view.getByLabelText(field.label);
    assert.equal(input.name, field.name);
    assert.equal(input.type, field.type ?? "text");
    assert.equal(input.value, "initial");
    assert.ok(view.getByText("Invalid value"));
    fireEvent.change(input, { target: { value: "updated" } });
    fireEvent.blur(input);
    assert.deepEqual(changes, ["updated"]);
    assert.equal(blurCount, 1);
    view.rerender(
      createElement(AuthFormField, { ...props, errors: [], value: "updated" })
    );
    assert.equal(input.value, "updated");
    assert.equal(view.queryByText("Invalid value"), null);
  }
);

test("input group adornments focus the control without taking focus from their buttons", () => {
  const view = render(
    createElement(
      InputGroup,
      { "aria-label": "Search controls" },
      createElement(InputGroupInput, { "aria-label": "Search" }),
      createElement(InputGroupAddon, {}, "Prefix"),
      createElement(
        InputGroupAddon,
        { align: "inline-end" },
        createElement(InputGroupButton, {}, "Search action")
      )
    )
  );
  assert.ok(view.getByRole("group", { name: "Search controls" }));
  const input = view.getByRole("textbox", { name: "Search" });
  fireEvent.click(view.getByText("Prefix"));
  assert.equal(document.activeElement, input);
  const button = view.getByRole("button", { name: "Search action" });
  button.focus();
  fireEvent.click(button);
  assert.equal(document.activeElement, button);
});
