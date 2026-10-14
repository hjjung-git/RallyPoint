// 서버에서 온 글은 항상 textContent로만 넣는다(HTML로 해석하지 않는다).
const SVG_NS = "http://www.w3.org/2000/svg";

export type Attrs = Record<string, string | number | undefined>;

function apply(node: Element, attrs: Attrs): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined) {
      node.removeAttribute(name);
    } else {
      node.setAttribute(name, String(value));
    }
  }
}

export function html<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  apply(node, attrs);
  node.append(...children);
  return node;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  apply(node, attrs);
  node.append(...children);
  return node;
}

export function setAttrs(node: Element, attrs: Attrs): void {
  apply(node, attrs);
}

export function setText(node: Element, text: string): void {
  if (node.textContent !== text) {
    node.textContent = text;
  }
}

export interface KeyedItem<E extends Element> {
  key: string;
  make(): E;
  update(node: E): void;
}

// key로 노드를 재사용하는 목록. 사라진 key의 노드는 지운다.
// 노드를 다시 만들지 않으므로 CSS 애니메이션이 끊기지 않는다.
export class Keyed<E extends Element> {
  private readonly nodes = new Map<string, E>();

  constructor(private readonly parent: Element) {}

  sync(items: KeyedItem<E>[]): void {
    const seen = new Set<string>();
    for (const item of items) {
      seen.add(item.key);
      let node = this.nodes.get(item.key);
      if (!node) {
        node = item.make();
        this.nodes.set(item.key, node);
        this.parent.appendChild(node);
      }
      item.update(node);
    }
    for (const [key, node] of this.nodes) {
      if (!seen.has(key)) {
        node.remove();
        this.nodes.delete(key);
      }
    }
  }
}
