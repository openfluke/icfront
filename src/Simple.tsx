import React, { Component, createRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import initJolt from "jolt-physics";
import { IsoCard, IsoDeps } from "isocard";

type State = {
  log: string[];
  jsonText: string;
  playing: boolean;
  ready: boolean;
};

export default class Simple extends Component<{}, State> {
  containerRef = createRef<HTMLDivElement>();
  iso: IsoCard | null = null;
  joltModule: any | null = null;

  state: State = {
    log: [],
    jsonText: JSON.stringify(
      [
        {
          type: "scene",
          background: 0x1a1a1a,
          camera: {
            position: [5, 5, 5],
            lookAt: [0, 0, 0],
            orbitEnabled: true,
            orbitTarget: [0, 0, 0],
            fov: 60,
            near: 0.1,
            far: 1000
          }
        },
        { type: "helper", helperType: "axes", size: 3 },
        { type: "helper", helperType: "grid", size: 20, divisions: 20 },
        { type: "light", lightType: "ambient", color: 0x808080 },
        { type: "light", lightType: "directional", color: 0xffffff, intensity: 1.75, pos: [6, 8, 5] },
        {
          name: "ball",
          type: "mesh",
          shape: { type: "sphere", radius: 1, widthSegments: 32, heightSegments: 16, thetaLength: 6.283185307179586 },
          material: { type: "basic", color: 0x33aaff },
          pos: [0, 1, 0]
        }
      ],
      null,
      2
    ),
    playing: false,
    ready: false
  };

  log = (m: string) => this.setState((s) => ({ log: [...s.log, m] }));

  private joltInit = async () => {
    if (this.joltModule) return this.joltModule;
    this.log("Initializing Jolt...");
    try {
      this.joltModule = await initJolt();
      this.log("Jolt initialized");
      return this.joltModule;
    } catch (e: any) {
      this.log("Jolt init failed: " + (e?.message || e));
      throw e;
    }
  };

  private destroyIsoCard() {
    if (!this.iso) return;
    try {
      this.iso.stopPhysics();
      this.iso.objects.forEach((obj) => this.iso!.removeObject(obj.id));
      this.iso.dynamicObjects = [];
      this.iso.savedTransforms.clear();
      this.iso.attractors = [];
      this.iso.constraints = [];
      if (this.iso.renderer) {
        this.iso.renderer.dispose();
        if (this.containerRef.current && this.iso.renderer.domElement) {
          this.containerRef.current.removeChild(this.iso.renderer.domElement);
        }
      }
      this.iso = null;
      this.log("IsoCard destroyed");
    } catch (e: any) {
      this.log("IsoCard destroy failed: " + (e?.message || e));
    }
  }

  private async createIsoCard() {
    if (!this.containerRef.current) {
      this.log("Container ref not found");
      return;
    }

    const deps: IsoDeps = {
      THREE,
      OrbitControls,
      joltInit: this.joltInit
    };

    try {
      this.log("Creating IsoCard...");
      this.iso = new IsoCard(this.containerRef.current, deps, {});
      this.log("IsoCard created");

      // Set camera config
      this.iso.setCameraConfig({
        position: [5, 5, 5],
        lookAt: [0, 0, 0],
        orbitEnabled: true,
        orbitTarget: [0, 0, 0],
        fov: 60,
        near: 0.1,
        far: 1000
      });
      this.log("Camera configured");

      // Load scene JSON
      try {
        this.log("Interpreting JSON...");
        const objects = this.iso.interpretJSON(this.state.jsonText);
        this.iso.renderScene();
        this.log(`Scene loaded with ${objects.length} objects`);
      } catch (e: any) {
        this.log("Scene load failed: " + (e?.message || e));
        throw e;
      }

      // Start animation loop
      this.iso.startAnimate();
      this.log("Animation started");
    } catch (e: any) {
      this.log("IsoCard init error: " + (e?.message || e));
      throw e;
    }
  }

  async componentDidMount() {
    await this.createIsoCard();
    if (this.iso) {
      const handleResize = () => {
        this.iso!.onResize();
        this.iso!.renderScene();
      };
      window.addEventListener("resize", handleResize);
      this.setState({ ready: true });
    }
  }

  componentWillUnmount() {
    window.removeEventListener("resize", () => {});
    this.destroyIsoCard();
  }

  handleLoadScene = async () => {
    this.destroyIsoCard();
    await this.createIsoCard();
  };

  togglePlay = async () => {
    if (!this.iso) return;
    const next = !this.state.playing;
    if (next) {
      if (!this.iso.isPhysicsInitialized()) {
        this.log("Setting up JOLT physics...");
        try {
          await this.iso.setupJOLT();
          await this.iso.initializeScenePhysics();
          this.log("Physics initialized");
        } catch (e: any) {
          this.log("Physics setup failed: " + (e?.message || e));
          return;
        }
      }
      this.iso.startPhysics();
      this.log("Physics started");
    } else {
      this.iso.stopPhysics();
      this.log("Physics stopped");
    }
    this.setState({ playing: next });
  };

  render() {
    return (
      <div style={{ height: "100vh", display: "grid", gridTemplateRows: "1fr auto" }}>
        <div ref={this.containerRef} style={{ minHeight: 0, height: "100%" }} />
        <div style={{ padding: 12, borderTop: "1px solid #333", background: "#111", color: "#ddd" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button
              className="button is-primary"
              onClick={this.handleLoadScene}
              disabled={!this.state.ready}
            >
              Reload Scene
            </button>
            <button
              className={`button ${this.state.playing ? "is-danger" : "is-success"}`}
              onClick={this.togglePlay}
              disabled={!this.state.ready}
            >
              {this.state.playing ? "Stop" : "Play"}
            </button>
          </div>
          <textarea
            value={this.state.jsonText}
            onChange={(e) => this.setState({ jsonText: e.target.value })}
            rows={6}
            style={{ width: "100%", fontFamily: "monospace" }}
          />
          <pre style={{ marginTop: 8, maxHeight: 120, overflow: "auto" }}>
            {this.state.log.join("\n")}
          </pre>
        </div>
      </div>
    );
  }
}