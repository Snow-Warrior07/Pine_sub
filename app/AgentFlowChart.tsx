"use client";

import { useEffect, useRef } from "react";
import Lottie from "lottie-react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Position,
  Handle,
  NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import managerAnim  from "../public/icon_manager.json";
import hackAnim     from "../public/icon_hack.json";
import fixAnim      from "../public/icon_fix.json";
import testingAnim  from "../public/icon_testing.json";

// ─── Types ────────────────────────────────────────────────────────────────────
export type TeamStatus = "idle" | "working" | "done" | "error";

export type FlowState = {
  manager:         TeamStatus;
  securityLead:    TeamStatus;
  patchEngineer:   TeamStatus;
  codeIntegration: TeamStatus;
};

type TeamNodeData = {
  label:      string;
  role:       string;
  agents:     string[];
  status:     TeamStatus;
  animData:   object;
  spawning:   boolean;   // true for the first frame — drives pop-in animation
  sourcePos?: Position;
  targetPos?: Position;
};

// ─── Spawn pop-in keyframe (injected once) ────────────────────────────────────
const SPAWN_STYLE_ID = "agent-spawn-keyframes";
if (typeof document !== "undefined" && !document.getElementById(SPAWN_STYLE_ID)) {
  const style = document.createElement("style");
  style.id = SPAWN_STYLE_ID;
  style.textContent = `
    @keyframes agentSpawn {
      0%   { opacity: 0; transform: scale(0.4) translateY(20px); }
      60%  { opacity: 1; transform: scale(1.06) translateY(-4px); }
      80%  { transform: scale(0.97) translateY(1px); }
      100% { opacity: 1; transform: scale(1) translateY(0); }
    }
    @keyframes edgeSpawn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
  `;
  document.head.appendChild(style);
}

// ─── Team node component ──────────────────────────────────────────────────────
function TeamNode({ data }: NodeProps) {
  const d = data as TeamNodeData;
  const isWorking = d.status === "working";
  const isDone    = d.status === "done";
  const isError   = d.status === "error";

  const borderColor = isWorking ? "#0077cc" : isDone ? "#008949" : isError ? "#c0152a" : "#b8cedd";
  const bgColor     = isWorking ? "rgba(0,119,204,0.06)" : isDone ? "rgba(0,137,73,0.06)" : isError ? "rgba(192,21,42,0.06)" : "rgba(255,255,255,0.95)";
  const dotColor    = isWorking ? "#0077cc" : isDone ? "#008949" : isError ? "#c0152a" : "#b8cedd";

  return (
    <div
      style={{
        width: 180,
        borderRadius: 14,
        border: `2px solid ${borderColor}`,
        background: bgColor,
        padding: "14px 16px 12px",
        boxShadow: isWorking
          ? "0 0 0 3px rgba(0,119,204,0.18), 0 4px 20px rgba(0,60,120,0.12)"
          : "0 2px 12px rgba(0,60,120,0.07)",
        animation: d.spawning
          ? "agentSpawn 0.55s cubic-bezier(0.34,1.56,0.64,1) forwards"
          : isWorking
          ? "teamBlink 1.2s ease-in-out infinite"
          : "none",
        transition: "border-color 0.3s, background 0.3s, box-shadow 0.3s",
        fontFamily: "ClashDisplay, system-ui, sans-serif",
      }}
    >
      <Handle type="target" position={d.targetPos ?? Position.Top} style={{ opacity: 0 }} />

      <div style={{ width: 64, height: 64, margin: "0 auto 8px" }}>
        <Lottie
          animationData={d.animData}
          loop={isWorking}
          autoplay={isWorking}
          style={{ width: "100%", height: "100%" }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, justifyContent: "center" }}>
        <span
          style={{
            width: 8, height: 8, borderRadius: "50%",
            background: dotColor, display: "inline-block", flexShrink: 0,
            boxShadow: isWorking ? "0 0 6px rgba(0,119,204,0.8)" : "none",
          }}
        />
        <span style={{ fontWeight: 800, fontSize: 13, color: "#001c35", letterSpacing: "-0.2px" }}>
          {d.label}
        </span>
      </div>

      <div style={{ fontSize: 10, color: "#4a7090", textAlign: "center", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 8 }}>
        {d.role}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, justifyContent: "center" }}>
        {d.agents.map((a) => (
          <span
            key={a}
            style={{
              fontSize: 9, padding: "2px 6px", borderRadius: 999,
              background: isWorking ? "rgba(0,119,204,0.1)" : "#eaf1f8",
              border: `1px solid ${isWorking ? "rgba(0,119,204,0.3)" : "#c2d5e5"}`,
              color: isWorking ? "#004a8f" : "#6a8fa8",
              fontWeight: 700, letterSpacing: "0.4px", textTransform: "uppercase",
            }}
          >
            {a}
          </span>
        ))}
      </div>

      <Handle type="source" position={d.sourcePos ?? Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { team: TeamNode };

// ─── Layout constants ─────────────────────────────────────────────────────────
const NODE_W   = 180;
const COL_GAP  = 40;
const LEFT_X   = 0;
const RIGHT_X  = NODE_W + COL_GAP;   // 220
const CENTER_X = (LEFT_X + RIGHT_X) / 2; // 110

// ─── Full node / edge definitions (all 4 nodes) ───────────────────────────────
const ALL_NODES_DEF = [
  {
    id: "manager",
    type: "team",
    position: { x: CENTER_X, y: 0 },
    data: { label: "Manager", role: "Orchestrator", agents: ["Orchestrator"], status: "idle" as TeamStatus, animData: managerAnim, spawning: false },
  },
  {
    id: "securityLead",
    type: "team",
    position: { x: LEFT_X, y: 240 },
    data: { label: "Security Lead", role: "Recon & Analysis", agents: ["Recon", "Analyst", "Validator"], status: "idle" as TeamStatus, animData: hackAnim, spawning: false },
  },
  {
    id: "patchEngineer",
    type: "team",
    position: { x: RIGHT_X, y: 240 },
    data: { label: "Patch Engineer", role: "Remediation", agents: ["Remediation"], status: "idle" as TeamStatus, animData: fixAnim, spawning: false, targetPos: Position.Top, sourcePos: Position.Bottom },
  },
  {
    id: "codeIntegration",
    type: "team",
    position: { x: CENTER_X, y: 480 },
    data: { label: "Code Integration", role: "Reporter", agents: ["Reporter"], status: "idle" as TeamStatus, animData: testingAnim, spawning: false, targetPos: Position.Top },
  },
];

const ALL_EDGES_DEF = [
  { id: "e-mgr-sec",   source: "manager",      target: "securityLead",   animated: true },
  { id: "e-mgr-patch", source: "manager",      target: "patchEngineer",  animated: true },
  { id: "e-sec-code",  source: "securityLead", target: "codeIntegration", animated: true },
  { id: "e-patch-code",source: "patchEngineer",target: "codeIntegration", animated: true },
];

// Which node/edges become visible when a team first activates
const SPAWN_MAP: Record<keyof FlowState, { nodeIds: string[]; edgeIds: string[] }> = {
  manager:         { nodeIds: ["manager"],         edgeIds: [] },
  securityLead:    { nodeIds: ["securityLead"],    edgeIds: ["e-mgr-sec"] },
  patchEngineer:   { nodeIds: ["patchEngineer"],   edgeIds: ["e-mgr-patch"] },
  codeIntegration: { nodeIds: ["codeIntegration"], edgeIds: ["e-sec-code", "e-patch-code"] },
};

function makeEdge(id: string, active = false) {
  const def = ALL_EDGES_DEF.find(e => e.id === id)!;
  return {
    ...def,
    style: { stroke: active ? "#0077cc" : "#b8cedd", strokeWidth: active ? 2.5 : 2, animation: "edgeSpawn 0.4s ease forwards" },
    markerEnd: { type: "arrowclosed" as const, color: active ? "#0077cc" : "#b8cedd" },
  };
}

function isEdgeActive(id: string, fs: FlowState) {
  return (
    (id === "e-mgr-sec"    && (fs.manager === "working" || fs.securityLead === "working")) ||
    (id === "e-mgr-patch"  && (fs.manager === "working" || fs.patchEngineer === "working")) ||
    (id === "e-sec-code"   && (fs.securityLead === "working" || fs.codeIntegration === "working")) ||
    (id === "e-patch-code" && (fs.patchEngineer === "working" || fs.codeIntegration === "working"))
  );
}

function nodeStatus(id: string, fs: FlowState): TeamStatus {
  return (fs as any)[{
    manager: "manager", securityLead: "securityLead",
    patchEngineer: "patchEngineer", codeIntegration: "codeIntegration",
  }[id] ?? ""] ?? "idle";
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function AgentFlowChart({ flowState }: { flowState: FlowState }) {
  // Start with only manager node visible
  const [nodes, setNodes, onNodesChange] = useNodesState([ALL_NODES_DEF[0]] as any);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as any);

  // Track which node IDs have already been spawned so we only trigger once
  const spawnedRef = useRef<Set<string>>(new Set(["manager"]));

  useEffect(() => {
    const teams: (keyof FlowState)[] = ["manager", "securityLead", "patchEngineer", "codeIntegration"];

    for (const team of teams) {
      const status = flowState[team];
      // Spawn when the team first becomes active (working OR done) and hasn't been spawned yet
      const { nodeIds, edgeIds } = SPAWN_MAP[team];
      const alreadySpawned = nodeIds.every(id => spawnedRef.current.has(id));

      if (!alreadySpawned && (status === "working" || status === "done" || status === "error")) {
        // Mark as spawned
        nodeIds.forEach(id => spawnedRef.current.add(id));

        // Add nodes with spawning=true
        setNodes(prev => {
          const existingIds = new Set(prev.map((n: any) => n.id));
          const toAdd = nodeIds
            .filter(id => !existingIds.has(id))
            .map(id => {
              const def = ALL_NODES_DEF.find(n => n.id === id)!;
              return {
                ...def,
                data: { ...def.data, status: nodeStatus(id, flowState), spawning: true },
              };
            });
          return [...prev, ...toAdd];
        });

        // Add edges
        setEdges(prev => {
          const existingIds = new Set(prev.map((e: any) => e.id));
          const toAdd = edgeIds
            .filter(id => !existingIds.has(id))
            .map(id => makeEdge(id, isEdgeActive(id, flowState)));
          return [...prev, ...toAdd];
        });

        // After animation completes, clear spawning flag
        setTimeout(() => {
          setNodes(prev =>
            prev.map((n: any) =>
              nodeIds.includes(n.id) ? { ...n, data: { ...n.data, spawning: false } } : n
            )
          );
        }, 600);
      }
    }

    // Always update status + edge colours for already-spawned nodes
    setNodes(prev =>
      prev.map((n: any) => ({
        ...n,
        data: { ...n.data, status: nodeStatus(n.id, flowState) },
      }))
    );

    setEdges(prev =>
      prev.map((e: any) => {
        const active = isEdgeActive(e.id, flowState);
        return {
          ...e,
          style: { ...e.style, stroke: active ? "#0077cc" : "#b8cedd", strokeWidth: active ? 2.5 : 2, animation: "none" },
          markerEnd: { type: "arrowclosed" as const, color: active ? "#0077cc" : "#b8cedd" },
        };
      })
    );
  }, [flowState, setNodes, setEdges]);

  // Reset on scan re-start (all idle = new scan)
  const prevFlowRef = useRef(flowState);
  useEffect(() => {
    const allIdle = Object.values(flowState).every(s => s === "idle");
    const hadActivity = Object.values(prevFlowRef.current).some(s => s !== "idle");
    if (allIdle && hadActivity) {
      spawnedRef.current = new Set(["manager"]);
      setNodes([ALL_NODES_DEF[0]] as any);
      setEdges([] as any);
    }
    prevFlowRef.current = flowState;
  }, [flowState, setNodes, setEdges]);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.3}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#c2d5e5" gap={24} size={1} />
        <Controls
          style={{ background: "rgba(255,255,255,0.9)", border: "1px solid #c2d5e5", borderRadius: 8, boxShadow: "0 2px 8px rgba(0,60,120,0.08)" }}
          showInteractive={false}
        />
        <MiniMap
          nodeColor={(n) => {
            const s = (n.data as any)?.status as TeamStatus | undefined;
            return s === "working" ? "#0077cc" : s === "done" ? "#008949" : s === "error" ? "#c0152a" : "#c2d5e5";
          }}
          style={{ background: "rgba(245,249,253,0.95)", border: "1px solid #c2d5e5", borderRadius: 8 }}
          maskColor="rgba(200,220,235,0.3)"
        />
      </ReactFlow>
    </div>
  );
}
