import { test, expect } from "bun:test";
import { Separator } from "@inquirer/prompts";
import { toSelectChoices } from "../../src/cli/prompt";

test("toSelectChoices turns a separator item into a Separator instance", () => {
  const [choice] = toSelectChoices([{ separator: " " }]);
  expect(choice).toBeInstanceOf(Separator);
});

test("toSelectChoices passes a name/value item through untouched", () => {
  expect(toSelectChoices([{ name: "web1", value: "web1" }])).toEqual([{ name: "web1", value: "web1" }]);
});

test("toSelectChoices preserves order across a mix of both kinds", () => {
  const result = toSelectChoices([{ name: "a", value: "a" }, { separator: "" }, { name: "b", value: "b" }]);
  expect(result).toHaveLength(3);
  expect(result[1]).toBeInstanceOf(Separator);
});
