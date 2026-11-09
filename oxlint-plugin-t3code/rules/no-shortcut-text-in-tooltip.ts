import { defineRule, type ESTree } from "@oxlint/plugins";

const MESSAGE =
  "Do not write a shortcut label into tooltip text. Use ShortcutTooltip or ShortcutHint from components/focusLevels/ShortcutHint so shortcuts render as keys.";
const TWO_ACTIONS_MESSAGE =
  "A tooltip that names two actions lists them as rows. Give them as TooltipRows (or a TooltipContent `rows` list) so each row is a button that runs its command.";
const GESTURE_MESSAGE =
  'Do not describe a click gesture in tooltip text. A second action is a TooltipRow with its command; the row name may end with the gesture, such as "(Shift+click)".';
const CARD_ROW_MESSAGE =
  "A ThreadHoverCard row is a ThreadHoverCardRow with an explicit `action` (or null), not a raw element.";

// A modifier, then an optional joiner with spaces, then "click": "Shift+click", "Shift + click",
// "⌘-click", "Ctrl/⌘-click". No leading word boundary: `\b` does not match before a symbol.
const GESTURE_PATTERN =
  /(?:Shift|Ctrl|Alt|Cmd|Option|⌘|⌥|⇧|⌃)\s*[+/-]?\s*(?:⌘|Cmd)?\s*-?\s*click\b/iu;

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
    type Child = ESTree.JSXElement["children"][number];
    // The JSX elements an expression can render: `{cond ? <A/> : <B/>}`, `{cond && <A/>}`, fragments.
    const elementsIn = (node: Node): ESTree.JSXElement[] => {
      if (!node) return [];
      switch (node.type) {
        case "JSXElement":
          return [node];
        case "JSXFragment":
          return node.children.flatMap((child) => elementsIn(child));
        case "JSXExpressionContainer":
          return elementsIn(node.expression as Node);
        case "ConditionalExpression":
          return [...elementsIn(node.consequent), ...elementsIn(node.alternate)];
        case "LogicalExpression":
          return [...elementsIn(node.left), ...elementsIn(node.right)];
        default:
          return [];
      }
    };
    // The literal strings an expression can produce, through conditionals, templates and `+`.
    const textsIn = (node: Node): string[] => {
      if (!node) return [];
      switch (node.type) {
        case "Literal":
          return typeof node.value === "string" ? [node.value] : [];
        case "TemplateLiteral":
          return node.quasis.map((quasi) => quasi.value.cooked ?? "");
        case "JSXText":
          return [node.value];
        case "JSXExpressionContainer":
          return textsIn(node.expression as Node);
        case "ConditionalExpression":
          return [...textsIn(node.consequent), ...textsIn(node.alternate)];
        case "LogicalExpression":
          return [...textsIn(node.left), ...textsIn(node.right)];
        case "BinaryExpression":
          return node.operator === "+" ? [...textsIn(node.left), ...textsIn(node.right)] : [];
        default:
          return [];
      }
    };
    const countHints = (children: ReadonlyArray<Child>): number =>
      children.reduce((count, child) => {
        if (child.type === "JSXText") return count;
        return elementsIn(child).reduce(
          (inner, element) =>
            inner +
            (elementName(element) === "ShortcutHint" ? 1 : 0) +
            countHints(element.children),
          count,
        );
      }, 0);
    const hasGestureText = (children: ReadonlyArray<Child>): boolean =>
      children.some(
        (child) =>
          textsIn(child).some((text) => GESTURE_PATTERN.test(text)) ||
          elementsIn(child).some((element) => hasGestureText(element.children)),
      );
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
            for (const element of elementsIn(child)) {
              const childName = elementName(element);
              if (childName !== null && /^[a-z]/u.test(childName)) {
                context.report({ node: element, message: CARD_ROW_MESSAGE });
              }
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
