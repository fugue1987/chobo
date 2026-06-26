import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { FilterBar } from "../src/components/FilterBar.js";
import type { Filters } from "../src/api/types.js";

function Harness() {
  const [f, setF] = useState<Filters>({});
  return (<><FilterBar filters={f} onChange={setF} /><pre data-testid="state">{JSON.stringify(f)}</pre></>);
}

it("typing a user_id updates filter state", async () => {
  render(<Harness />);
  await userEvent.type(screen.getByPlaceholderText("user_id"), "teacher-1");
  expect(screen.getByTestId("state").textContent).toContain("\"user_id\":\"teacher-1\"");
});

it("clearing resets to empty", async () => {
  render(<Harness />);
  await userEvent.type(screen.getByPlaceholderText("org_id"), "school-x");
  await userEvent.click(screen.getByRole("button", { name: "清空" }));
  expect(screen.getByTestId("state").textContent).toBe("{}");
});

it("typing a provider updates filter state", async () => {
  render(<Harness />);
  await userEvent.type(screen.getByPlaceholderText("provider"), "doubao");
  expect(screen.getByTestId("state").textContent).toContain("\"provider\":\"doubao\"");
});

it("typing an account updates filter state", async () => {
  render(<Harness />);
  await userEvent.type(screen.getByPlaceholderText("account"), "five-elements");
  expect(screen.getByTestId("state").textContent).toContain("\"account\":\"five-elements\"");
});

it("clearing resets the date input visually", () => {
  render(<Harness />);
  const from = screen.getByLabelText("from") as HTMLInputElement;
  fireEvent.change(from, { target: { value: "2026-06-25T10:00" } });
  expect(from.value).toBe("2026-06-25T10:00");
  fireEvent.click(screen.getByRole("button", { name: "清空" }));
  expect(from.value).toBe("");
});
