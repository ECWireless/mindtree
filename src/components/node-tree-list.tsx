import type { ReactNode } from "react";

import type { TreeNode } from "@/lib/nodes/tree";

type NodeTreeListProps = {
  roots: readonly TreeNode[];
  expanded: ReadonlySet<string>;
  renderNode: (node: TreeNode, depth: number) => ReactNode;
};

type RenderFrame = {
  node: TreeNode;
  depth: number;
  position: number;
  setSize: number;
};

export function NodeTreeList({ roots, expanded, renderNode }: NodeTreeListProps) {
  const visible: RenderFrame[] = [];
  const work: RenderFrame[] = [];

  for (let index = roots.length - 1; index >= 0; index -= 1) {
    work.push({ node: roots[index], depth: 0, position: index + 1, setSize: roots.length });
  }

  while (work.length > 0) {
    const frame = work.pop();
    if (!frame) {
      break;
    }

    visible.push(frame);
    if (frame.node.children.length > 0 && expanded.has(frame.node.id)) {
      for (let index = frame.node.children.length - 1; index >= 0; index -= 1) {
        work.push({
          node: frame.node.children[index],
          depth: frame.depth + 1,
          position: index + 1,
          setSize: frame.node.children.length,
        });
      }
    }
  }

  return (
    <ul className="node-list">
      {visible.map(({ node, depth, position, setSize }) => (
        <li
          key={node.id}
          aria-level={depth + 1}
          aria-posinset={position}
          aria-setsize={setSize}
        >
          {renderNode(node, depth)}
        </li>
      ))}
    </ul>
  );
}
