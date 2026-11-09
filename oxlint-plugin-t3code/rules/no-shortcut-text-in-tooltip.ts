import { defineRule, type ESTree } from "@oxlint/plugins";

const MESSAGE =
  "Do not write a shortcut label into tooltip text. Use ShortcutTooltip or ShortcutHint from components/focusLevels/ShortcutHint so shortcuts render as keys.";
const TWO_ACTIONS_MESSAGE =
  "A tooltip that names two actions lists them as rows. Give them as TooltipRows (or a TooltipContent `rows` list) so each row is a button that runs its command.";
const GESTURE_MESSAGE =
  'Do not describe a click gesture in tooltip text. A second action is a TooltipRow with its command; the row name may end with the gesture, such as "(Shift+click)".';
const CARD_ROW_MESSAGE =
  "A ThreadHoverCard row is a ThreadHoverCardRow with an explicit `action` (or null), not a raw element.";

const GESTURE_PATTERN = /\b(?:Shift|Ctrl|Alt|Cmd|Option|⌘|⌥|⇧|⌃)[+/-]?(?:⌘|Cmd)?-?click\b/iu;

const TEXT_ATTRIBUTES = new Set(["title", "tooltip"]);

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
      if (node.operator !== "+") return false;
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
    default:
      return false;
  }
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a shortcut label written into tooltip text, such as `Close (${shortcutLabel})`, a second action written as text, and raw hover card rows; use ShortcutHint, TooltipRows and ThreadHoverCardRow.",
    },
  },
  create(context) {
    // A label built in a variable first, then placed in the tooltip, is caught by name.
    const shortcutLabelVariables = new Set<string>();
    const embeds = (node: Node): boolean =>
      embedsShortcutLabel(node) ||
      (node?.type === "JSXExpressionContainer" &&
        node.expression.type === "Identifier" &&
        shortcutLabelVariables.has(node.expression.name)) ||
      (node?.type === "Identifier" && shortcutLabelVariables.has(node.name));
    const elementName = (node: ESTree.JSXElement): string | null =>
      node.openingElement.name.type === "JSXIdentifier" ? node.openingElement.name.name : null;
    const jsxChildName = (child: ESTree.JSXElement["children"][number]): string | null =>
      child.type === "JSXElement" ? elementName(child) : null;
    const countHints = (children: ReadonlyArray<ESTree.JSXElement["children"][number]>): number =>
      children.reduce((count, child) => {
        if (child.type === "JSXElement") {
          return (
            count + (elementName(child) === "ShortcutHint" ? 1 : 0) + countHints(child.children)
          );
        }
        if (child.type === "JSXExpressionContainer" && child.expression.type === "JSXElement") {
          return count + countHints([child.expression]);
        }
        return count;
      }, 0);
    const hasGestureText = (
      children: ReadonlyArray<ESTree.JSXElement["children"][number]>,
    ): boolean =>
      children.some((child) => {
        if (child.type === "JSXText") return GESTURE_PATTERN.test(child.value);
        if (child.type === "JSXElement") return hasGestureText(child.children);
        if (child.type === "JSXExpressionContainer") {
          const text = literalText(child.expression as Node);
          return text !== null && GESTURE_PATTERN.test(text);
        }
        return false;
      });
    return {
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && embedsShortcutLabel(node.init as Node)) {
          shortcutLabelVariables.add(node.id.name);
        }
      },
      JSXElement(node) {
        const name = elementName(node);
        if (name === "ThreadHoverCard") {
          for (const child of node.children) {
            const childName = jsxChildName(child);
            if (childName !== null && /^[a-z]/u.test(childName)) {
              context.report({ node: child, message: CARD_ROW_MESSAGE });
            }
          }
          return;
        }
        if (name !== "TooltipPopup") return;
        for (const child of node.children) {
          if (embeds(child)) context.report({ node: child, message: MESSAGE });
        }
        if (countHints(node.children) > 1) context.report({ node, message: TWO_ACTIONS_MESSAGE });
        if (hasGestureText(node.children)) context.report({ node, message: GESTURE_MESSAGE });
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || !TEXT_ATTRIBUTES.has(node.name.name)) return;
        if (embeds(node.value as Node)) context.report({ node, message: MESSAGE });
      },
    };
  },
});
