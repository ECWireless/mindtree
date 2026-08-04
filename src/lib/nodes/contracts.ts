export type CreateNodeInput = {
  title: string;
  parentId?: string | null;
};

export type RenameNodeInput = {
  id: string;
  title: string;
};

export type NodeLifecycleInput = {
  id: string;
};

export type MoveNodeInput = {
  id: string;
  parentId: string | null;
  position?: number;
};

export type NodeActionResult =
  | { ok: true; nodeId: string }
  | {
      ok: false;
      message: string;
      fieldErrors?: Record<string, string[]>;
    };
