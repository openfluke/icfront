// ClientIsoCardWatcher.tsx
import React, { Component, createRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { IsoCard, IsoDeps } from "isocard";

/* ---------------- Types for tolerant server payloads ---------------- */
type OneUpdate = {
  id?: string | number;
  name?: string;

  // common server keys:
  position?: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number; w: number };

  // tolerated alternates:
  pos?: [number, number, number];
  rot?: [number, number, number, number] | [number, number, number];
  eulerDeg?: [number, number, number];
  layerId?: string;
};

type PhysicsObjUpdate =
  | OneUpdate[]
  | Record<
      string | number,
      Omit<OneUpdate, "id" | "name"> & { id?: string | number; name?: string }
    >;

type State = {
  log: string[];
  jsonText: string;
  wsStatus: "disconnected" | "connecting" | "connected";
  serverUrl: string;
  layerId: string;
  ready: boolean;
};

/* ---------------- Small helpers ---------------- */
const stripPhysicsDeep = (obj: any) =>
  JSON.parse(JSON.stringify(obj, (k, v) => (k === "physics" ? undefined : v)));

const ensureSceneArray = (sceneLike: any): any[] =>
  Array.isArray(sceneLike) ? sceneLike : Array.isArray(sceneLike?.scene) ? sceneLike.scene : [sceneLike];

/* =================================================================== */
/*                            React Component                           */
/* =================================================================== */
export default class ClientIsoCardWatcher extends Component<{}, State> {
  containerRef = createRef<HTMLDivElement>();
  iso: IsoCard | null = null;
  socket: WebSocket | null = null;

  /** id/name → Object3D */
  private objectIndex = new Map<string | number, THREE.Object3D>();

  /** temps */
  private _tmpV = new THREE.Vector3();
  private _tmpQ = new THREE.Quaternion();
  private _tmpE = new THREE.Euler();

  /** frame-coalesced updates */
  private pending = new Map<string | number, OneUpdate>();
  private rafHandle: number | null = null;

  state: State = {
    log: [],
    jsonText: JSON.stringify(
      [
        {
          type: "scene",
          background: 0x1a1a1a,
          camera: {
            position: [6, 6, 8],
            lookAt: [0, 0, 0],
            orbitEnabled: true,
            orbitTarget: [0, 0, 0],
            fov: 60,
            near: 0.1,
            far: 1000,
          },
        },
        { type: "helper", helperType: "axes", size: 3 },
        { type: "helper", helperType: "grid", size: 20, divisions: 20 },
        { type: "light", lightType: "ambient", color: 0x808080 },
        { type: "light", lightType: "directional", color: 0xffffff, intensity: 1.75, pos: [6, 8, 5] },
        {
          name: "ball",
          type: "mesh",
          shape: { type: "sphere", radius: 1, widthSegments: 32, heightSegments: 16 },
          material: { type: "basic", color: 0x33aaff },
          pos: [0, 1, 0],
        },
      ],
      null,
      2
    ),
    wsStatus: "disconnected",
    serverUrl: "ws://localhost:5000", // required default
    layerId: "server_layer",
    ready: false,
  };

  log = (m: string) =>
    this.setState((s) => ({ log: [...s.log, `${new Date().toISOString()} — ${m}`].slice(-400) }));

  /* ---------------- IsoCard bootstrap / teardown ---------------- */
  private destroyIsoCard() {
    if (!this.iso) return;
    try {
      this.iso.stopAnimate?.();
      this.iso.objects?.forEach((o: any) => this.iso!.removeObject(o.id));
      const r: THREE.WebGLRenderer | undefined = (this.iso as any).renderer;
      if (r) {
        r.dispose();
        const el = r.domElement;
        if (this.containerRef.current && el?.parentElement === this.containerRef.current) {
          this.containerRef.current.removeChild(el);
        }
      }
      this.iso = null;
      this.objectIndex.clear();
      this.log("IsoCard destroyed");
    } catch (e: any) {
      this.log("IsoCard destroy failed: " + (e?.message || e));
    }
  }

  private createIsoCard() {
    if (!this.containerRef.current) {
      this.log("Container ref not found");
      return;
    }
    const deps: IsoDeps = { THREE, OrbitControls };
    try {
      this.log("Creating IsoCard…");
      this.iso = new IsoCard(this.containerRef.current, deps, { isPreview: true, isServer: false });
      this.iso.startAnimate();

      // resize
      const onResize = () => {
        this.iso!.onResize?.();
        this.iso!.renderScene?.();
      };
      window.addEventListener("resize", onResize);
      (this as any)._onResizeRef = onResize;

      this.setState({ ready: true });
    } catch (e: any) {
      this.log("IsoCard init error: " + (e?.message || e));
    }
  }

  componentDidMount() {
    this.createIsoCard();
    this.openWebSocket();
  }

  componentWillUnmount() {
    if ((this as any)._onResizeRef) window.removeEventListener("resize", (this as any)._onResizeRef);
    this.closeWebSocket();
    this.destroyIsoCard();
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
  }

  /* ---------------- WebSocket plumbing ---------------- */
  openWebSocket = () => {
    const { serverUrl } = this.state;
    this.log(`Connecting to ${serverUrl}`);
    this.setState({ wsStatus: "connecting" });
    this.closeWebSocket();
    try {
      const ws = new WebSocket(serverUrl);
      ws.onopen = () => {
        this.socket = ws;
        this.setState({ wsStatus: "connected" });
        this.log("WebSocket connected");
        // IMPORTANT: don't auto GET_SCENE to avoid duplicate loads.
        // If the server doesn't push SCENE_STATE on connect, use the button.
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
      ws.onclose = () => {
        this.log("WebSocket closed");
        this.socket = null;
        this.setState({ wsStatus: "disconnected" });
      };
      ws.onerror = () => {
        this.log("WebSocket error");
        this.setState({ wsStatus: "disconnected" });
      };
    } catch (e: any) {
      this.log("WebSocket connection failed: " + (e?.message || e));
      this.setState({ wsStatus: "disconnected" });
    }
  };

  closeWebSocket = () => {
    try {
      this.socket?.close();
    } catch {}
    this.socket = null;
    this.setState({ wsStatus: "disconnected" });
  };

  send = (payload: any) => {
    if (!this.socket || this.state.wsStatus !== "connected") {
      this.log("Not connected. Can't send.");
      return;
    }
    try {
      this.socket.send(JSON.stringify(payload));
      this.log(`Sent: ${payload.type}`);
    } catch (e: any) {
      this.log("Send failed: " + (e?.message || e));
    }
  };

  /* ---------------- Message handling ---------------- */
  onMessage = (data: string | ArrayBuffer) => {
    try {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      if (!text?.trim()) return;
      const msg = JSON.parse(text);
      const type = msg.type as string;
      if (!type) return;

      this.log(`Received: ${type}`);

      if (type === "SCENE_STATE") {
        this.handleSceneState(msg.scene ?? msg);
        return;
      }

      if (type === "PHYSICS_UPDATE" || type === "PHYSICS_TICK" || type === "TRANSFORMS") {
        const layerId = msg.layerId ?? msg.layer ?? undefined;
        const objects: PhysicsObjUpdate = msg.objects ?? msg.payload ?? msg.data ?? msg;
        this.enqueuePhysics(objects, layerId);
        return;
      }

      if (type === "ERROR") {
        this.log(`Server error: ${msg.message ?? "(no message)"}`);
      }
    } catch (e: any) {
      this.log("Message parse failed: " + (e?.message || e));
    }
  };

  /* ---------------- Scene / index helpers ---------------- */
  private getThreeScene(): THREE.Scene | undefined {
    const c: any = this.iso;
    return c?.scene || c?.rootScene || c?.threeScene;
  }

  private rebuildObjectIndex() {
    this.objectIndex.clear();
    const scene = this.getThreeScene();
    if (!scene) return;

    scene.traverse((obj) => {
      if (obj.name) this.objectIndex.set(obj.name, obj);
    });

    if (this.iso?.objects) {
      for (const entry of this.iso.objects as any[]) {
        const id = entry?.id;
        const obj: THREE.Object3D = entry?.threeObj || entry?.obj || entry;
        if (id !== undefined && obj) this.objectIndex.set(id, obj);
        const nm = entry?.config?.name;
        if (nm && obj) this.objectIndex.set(nm, obj);
      }
    }
    this.log(`Indexed ${this.objectIndex.size} ids/names`);
  }

  private resolveObject(idOrName: string | number): THREE.Object3D | undefined {
    const cached = this.objectIndex.get(idOrName);
    if (cached) return cached;

    const scene = this.getThreeScene();
    if (!scene) return undefined;

    if (typeof idOrName === "string") {
      const tryNames = [idOrName, idOrName.replace(/^server_layer/, "")];
      for (const n of tryNames) {
        const found = scene.getObjectByName(n);
        if (found) {
          this.objectIndex.set(idOrName, found);
          return found;
        }
      }
    }

    this.rebuildObjectIndex();
    return this.objectIndex.get(idOrName);
  }

  /* ---------------- Transform application ---------------- */
  private applyOneUpdateTo(target: THREE.Object3D, u: OneUpdate) {
    const obj =
      (target.parent && target.parent.type === "Group" && target.parent.name === target.name)
        ? target.parent
        : target;

    if (u.position) {
      obj.position.set(u.position.x, u.position.y, u.position.z);
    } else if (u.pos) {
      this._tmpV.fromArray(u.pos);
      obj.position.copy(this._tmpV);
    }

    if (u.rotation) {
      obj.quaternion.set(u.rotation.x, u.rotation.y, u.rotation.z, u.rotation.w);
    } else if (u.rot && u.rot.length === 4) {
      this._tmpQ.set(u.rot[0], u.rot[1], u.rot[2], u.rot[3]);
      obj.quaternion.copy(this._tmpQ);
    } else if (u.eulerDeg && u.eulerDeg.length === 3) {
      const [ex, ey, ez] = u.eulerDeg;
      this._tmpE.set((ex * Math.PI) / 180, (ey * Math.PI) / 180, (ez * Math.PI) / 180, "XYZ");
      obj.setRotationFromEuler(this._tmpE);
    } else if (u.rot && u.rot.length === 3) {
      const [rx, ry, rz] = u.rot;
      this._tmpE.set(rx, ry, rz, "XYZ");
      obj.setRotationFromEuler(this._tmpE);
    }

    obj.matrixWorldNeedsUpdate = true;
    obj.matrixAutoUpdate = true;

    const anyIso: any = this.iso;
    anyIso?.setTransform?.(obj, obj.position, obj.quaternion);
    anyIso?.onObjectTransformChanged?.(obj);
  }

  /* ---------------- Updates: collect + flush per frame ---------------- */
  private enqueuePhysics(objects: PhysicsObjUpdate, defaultLayerId?: string) {
    const arr: OneUpdate[] = [];

    if (Array.isArray(objects)) {
      for (const it of objects) {
        if (!it) continue;
        const idOrName = (it.id ?? it.name) as any;
        if (idOrName == null) continue;
        arr.push({ ...it, layerId: it.layerId ?? defaultLayerId });
      }
    } else if (objects && typeof objects === "object") {
      for (const key of Object.keys(objects)) {
        const o: any = (objects as any)[key];
        arr.push({ ...(o || {}), id: o?.id, name: o?.name ?? key, layerId: o?.layerId ?? defaultLayerId });
      }
    } else {
      return;
    }

    for (const u of arr) {
      const key = (u.id ?? u.name)!;
      const prev = this.pending.get(key) || { id: u.id, name: u.name };
      this.pending.set(key, { ...prev, ...u });
    }

    if (this.rafHandle == null) {
      this.rafHandle = requestAnimationFrame(() => {
        this.rafHandle = null;
        this.flushPending();
      });
    }
  }

  private flushPending() {
    if (!this.iso || this.pending.size === 0) return;

    let applied = 0;
    const layerHint = this.state.layerId;

    for (const [key, u] of this.pending) {
      const obj = this.resolveObject(key);
      if (!obj) continue;

      const mustLayer = u.layerId ?? layerHint;
      if (mustLayer) {
        const objLayer =
          (obj.userData?.layer as string) ||
          (obj.parent?.userData?.layer as string) ||
          obj.userData?.config?.layer ||
          "main";
        if (objLayer && objLayer !== mustLayer) continue;
      }

      this.applyOneUpdateTo(obj, u);
      applied++;
    }

    this.pending.clear();
    this.iso.renderScene?.();
    if (applied) this.log(`Applied ${applied} transform${applied === 1 ? "" : "s"}`);
  }

  /* ---------------- Layer utilities ---------------- */
  private clearLayer(layerId: string) {
    if (!this.iso?.objects) return;
    const toRemove: any[] = [];
    for (const entry of this.iso.objects as any[]) {
      const cfgLayer = entry?.config?.layer;
      if (cfgLayer === layerId) toRemove.push(entry);
    }
    for (const e of toRemove) {
      try {
        this.iso!.removeObject(e.id);
      } catch {}
    }
    if (toRemove.length) this.log(`Cleared ${toRemove.length} object(s) from layer "${layerId}"`);
  }

  /* ---------------- Scene ingestion ---------------- */
  handleSceneState = (sceneData: any) => {
    if (!this.iso) {
      this.log("IsoCard not ready");
      return;
    }
    try {
      const cleaned = stripPhysicsDeep(sceneData);
      const layerId = this.state.layerId;

      // Always clear the layer first to avoid duplicates.
      this.clearLayer(layerId);

      // Normalize: force every incoming object into our viewing layer.
      const payload = ensureSceneArray(cleaned).map((o: any) => ({ ...o, layer: layerId }));

      this.iso.addObjectsToLayer(layerId, payload);

      // Ensure layer field is visible on userData for transforms guard.
      try {
        this.iso.objects?.forEach((e: any) => {
          if (e?.threeObj) e.threeObj.userData.layer = e?.config?.layer || layerId;
        });
      } catch {}

      this.rebuildObjectIndex();
      this.iso.renderScene?.();

      this.log(`Scene loaded → layer "${layerId}" (objects: ${payload.length})`);
    } catch (e: any) {
      this.log("Scene load failed: " + (e?.message || e));
    }
  };

  /* ---------------- UI helpers ---------------- */
  handleSendScene = () => {
    try {
      const parsed = JSON.parse(this.state.jsonText);
      this.send({ type: "START", scene: parsed, layerName: this.state.layerId });
    } catch (e: any) {
      this.log("Invalid JSON: " + (e?.message || e));
    }
  };

  render() {
    const { log, jsonText, wsStatus, serverUrl, layerId } = this.state;
    return (
      <div style={{ height: "100vh", display: "grid", gridTemplateRows: "1fr auto" }}>
        <div ref={this.containerRef} style={{ minHeight: 0, height: "100%", background: "#111" }} />
        <div style={{ padding: 12, borderTop: "1px solid #333", background: "#0b0b0b", color: "#ddd" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input
              value={serverUrl}
              onChange={(e) => this.setState({ serverUrl: e.target.value })}
              style={{ width: 360, padding: 6 }}
              placeholder="WebSocket URL (e.g., ws://localhost:5000)"
            />
            <button onClick={wsStatus === "connected" ? this.closeWebSocket : this.openWebSocket}>
              {wsStatus === "connected" ? "Disconnect" : "Connect"}
            </button>
            <input
              value={layerId}
              onChange={(e) => this.setState({ layerId: e.target.value })}
              style={{ width: 200, padding: 6 }}
              placeholder="Layer ID (e.g., server_layer)"
            />
            <button onClick={() => this.send({ type: "GET_SCENE" })} disabled={wsStatus !== "connected"}>
              GET_SCENE
            </button>
            <button onClick={() => this.send({ type: "START_PHYSICS" })} disabled={wsStatus !== "connected"}>
              START_PHYSICS
            </button>
            <button onClick={() => this.send({ type: "STOP_PHYSICS" })} disabled={wsStatus !== "connected"}>
              STOP_PHYSICS
            </button>
            <button onClick={this.handleSendScene} disabled={wsStatus !== "connected"}>
              Send Scene (JSON)
            </button>
          </div>

          <textarea
            value={jsonText}
            onChange={(e) => this.setState({ jsonText: e.target.value })}
            rows={6}
            style={{ width: "100%", fontFamily: "monospace" }}
          />
          <pre style={{ marginTop: 8, maxHeight: 180, overflow: "auto" }}>{log.join("\n")}</pre>
        </div>
      </div>
    );
  }
}
