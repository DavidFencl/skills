// @ts-check

/**
 * Creates an element with attributes and children.
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {...(Node | string)} children
 */
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}
