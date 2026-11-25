import { defineRule, type ESTree } from "@oxlint/plugins";

const MESSAGE =
  "Do not write a shortcut label into tooltip text. Use ShortcutTooltip or ShortcutHint from components/focusLevels/ShortcutHint so shortcuts render as keys.";

const TEXT_ATTRIBUTES = new Set(["title", "tooltip"]);

// The `label` of a tooltip trigger, such as SharedTooltipTrigger, is its popup text.
const isTooltipTextAttribute = (node: ESTree.JSXAttribute): boolean => {
  if (node.name.type !== "JSXIdentifier") return false;
  if (TEXT_ATTRIBUTES.has(node.name.name)) return true;
  const element = node.parent.name;
  return (
    node.name.name === "label" &&
    element.type === "JSXIdentifier" &&
    element.name.endsWith("Trigger")
  );
};

type Node = ESTree.Node | ESTree.JSXElement["children"][number] | null | undefined;

const isShortcutLabel = (node: Node): boolean => {
  if (!node) return false;
  const name =
    node.type === "Identifier"
      ? node.name
      : node.type === "MemberExpression" && node.property.type === "Identifier"
        ? node.property.name
        : null;
  return name !== null && (name.endsWith("ShortcutLabel") || name.endsWith("shortcutLabel"));
};

const concatParts = (node: Node): ReadonlyArray<Node> =>
  node?.type === "BinaryExpression" && node.operator === "+"
    ? [...concatParts(node.left), ...concatParts(node.right)]
    : [node];

const literalText = (node: Node): string | null =>
  node?.type === "Literal" && typeof node.value === "string" ? node.value : null;

// Only the text built in place is checked. A label kept in a variable first is a known gap;
// revisit if such cases show up in review.
const embedsShortcutLabel = (node: Node): boolean => {
  if (!node) return false;
  switch (node.type) {
    case "TemplateLiteral":
      return node.expressions.some(
        (expression, index) =>
          isShortcutLabel(expression) &&
          (node.quasis[index]?.value.cooked ?? "").trimEnd().endsWith("("),
      );
    case "BinaryExpression": {
      const parts = concatParts(node);
      return parts.some(
        (part, index) =>
          (isShortcutLabel(part) &&
            (literalText(parts[index - 1]) ?? "").trimEnd().endsWith("(")) ||
          embedsShortcutLabel(part),
      );
    }
    case "ConditionalExpression":
      return embedsShortcutLabel(node.consequent) || embedsShortcutLabel(node.alternate);
    case "LogicalExpression":
      return embedsShortcutLabel(node.left) || embedsShortcutLabel(node.right);
    case "JSXExpressionContainer":
      return node.expression.type !== "JSXEmptyExpression" && embedsShortcutLabel(node.expression);
    case "JSXElement":
    case "JSXFragment":
      return node.children.some(embedsShortcutLabel);
    default:
      return false;
  }
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a shortcut label written into tooltip text, such as `Close (${shortcutLabel})`; render the keys as chips instead.",
    },
  },
  create(context) {
    return {
      JSXElement(node) {
        const name = node.openingElement.name;
        if (name.type !== "JSXIdentifier" || name.name !== "TooltipPopup") return;
        for (const child of node.children) {
          if (embedsShortcutLabel(child)) context.report({ node: child, message: MESSAGE });
        }
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || !isTooltipTextAttribute(node)) return;
        if (embedsShortcutLabel(node.value)) context.report({ node, message: MESSAGE });
      },
    };
  },
});
