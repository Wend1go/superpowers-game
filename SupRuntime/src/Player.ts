import * as async from "async";
import supFetch from "../../../../SupClient/src/fetch";

interface Project {
  name: string;
  assets: Entry[];
}

interface Entry {
  id: string;
  name: string;
  type: string;
  children?: any[];

  path: string;
  storagePath: string;
}

export default class Player {
  canvas: HTMLCanvasElement;
  dataURL: string;
  gameName: string;

  gameInstance: SupEngine.GameInstance;

  entriesById: { [name: string]: any; } = {};
  entriesByPath: { [name: string]: any; } = {};
  resources: { [name: string]: any; } = {};

  private assetsById: { [name: string]: any; } = {};
  outerAssetsById: { [name: string]: any; } = {};

  resourcesToLoad: string[];

  assetsToLoad: Entry[];

  accumulatedTime: number;
  lastTimestamp: number;
  tickAnimationFrameId: number;

  constructor(canvas: HTMLCanvasElement, dataURL: string, options: { debug?: boolean; enableOnExit?: boolean; }) {
    this.canvas = canvas;
    this.dataURL = dataURL;

    options.enableOnExit = true;
    this.gameInstance = new SupEngine.GameInstance(this.canvas, options);
  }

  load(progressCallback: (progress: number, total: number) => any, callback: any) {
    let progress = 0;

    let innerProgressCallback = () => {
      progress++;
      let total = this.resourcesToLoad.length + this.assetsToLoad.length;
      progressCallback(progress, total);
    };
    async.series([
      (cb) => { this._loadManifest(cb); },
      (cb) => { this._loadResources(innerProgressCallback, cb); },
      (cb) => { this._loadAssets(innerProgressCallback, cb); },
      (cb) => { this._initPlugins(cb); },
      (cb) => { this._startPlugins(cb); },
      (cb) => { this._lateStartPlugins(cb); }
    ], callback);
  }

  _loadManifest(callback: Function) {
    this.getAssetData("project.json", "json", (err: any, project: Project) => {
      if (err != null) { callback(new Error("Failed to load game manifest")); return; }

      this.gameName = project.name;
      document.title = project.name;

      this.resourcesToLoad = Object.keys(SupRuntime.resourcePlugins);

      this.assetsToLoad = [];
      let walk = (asset: Entry, parent = "", storagePath = "") => {
        let children: string[];
        if (asset.children != null) {
          children = [];
          for (let child of asset.children) { children.push(child.name); }
        }
        let path = `${parent}${asset.name}`;
        storagePath += `${asset.name} (${asset.id})`;
        this.assetsToLoad.push({ id: asset.id, name: asset.name, path, storagePath, type: asset.type, children });
        parent += `${asset.name}/`;
        storagePath += "/";
        if (asset.children == null) return;
        for (let child of asset.children) { walk(child, parent, storagePath); }
      };
      for (let asset of project.assets) { walk(asset); }

      callback();
    });
  }

  _loadResources(progressCallback: Function, callback: any) {
    if (this.resourcesToLoad.length === 0) { callback(); return; }
    let resourcesLoaded = 0;

    let onResourceLoaded = (err: any, resourceName: string, resource: any) => {
      if (err != null) { callback(new Error(`Failed to load resource ${resourceName}: ${err.message}`)); return; }

      this.resources[resourceName] = resource;

      progressCallback();
      resourcesLoaded++;
      if (resourcesLoaded === this.resourcesToLoad.length) callback();
    };

    // NOTE: Have to use .forEach because of TS4091 (closure references block-scoped variable)
    this.resourcesToLoad.forEach((resourceName) => {
      let plugin = SupRuntime.resourcePlugins[resourceName];
      if (plugin == null) {
        // This resource isn't meant to be loaded at runtime, skip
        onResourceLoaded(null, resourceName, null);
        return;
      }

      plugin.loadResource(this, resourceName, (err, data) => { onResourceLoaded(err, resourceName, data); });
    });
  }

  _loadAssets(progressCallback: Function, callback: any) {
    if (this.gameInstance.threeRenderer == null) { callback(new Error("Failed to initialize renderer. Your device might not support WebGL.")); return; }

    if (this.assetsToLoad.length === 0 ) { callback(); return; }
    let assetsLoaded = 0;

    let onAssetLoaded = (err: any, entry: any, asset: any) => {
      if (err != null) { callback(new Error(`Failed to load asset ${entry.path}: ${err.message}`)); return; }

      this.entriesById[entry.id] = entry;
      this.entriesByPath[entry.path] = entry;
      this.assetsById[entry.id] = asset;

      progressCallback();
      assetsLoaded++;
      if (assetsLoaded === this.assetsToLoad.length) callback();
    };

    // NOTE: Have to use .forEach because of TS4091 (closure references block-scoped variable)
    this.assetsToLoad.forEach((entry) => {
      if (entry.children != null) {
        onAssetLoaded(null, entry, {});
        return;
      }

      let plugin = SupRuntime.plugins[entry.type];
      if (plugin == null || plugin.loadAsset == null) {
        console.warn(`Don't know how to load assets of type "${entry.type}"`);
        onAssetLoaded(null, entry, {});
        return;
      }

      plugin.loadAsset(this, entry, (err, data) => { onAssetLoaded(err, entry, data); });
    });
  }

  _initPlugins(callback: any) {
    async.each(Object.keys(SupRuntime.plugins), (name, cb) => {
      let plugin = SupRuntime.plugins[name];
      if (plugin.init != null) plugin.init(this, cb);
      else cb();
    }, callback);
  }

  _startPlugins(callback: any) {
    async.each(Object.keys(SupRuntime.plugins), (name, cb) => {
      let plugin = SupRuntime.plugins[name];
      if (plugin.start != null) plugin.start(this, cb);
      else cb();
    }, callback);
  }

  _lateStartPlugins(callback: any) {
    async.each(Object.keys(SupRuntime.plugins), (name, cb) => {
      let plugin = SupRuntime.plugins[name];
      if (plugin.lateStart != null) plugin.lateStart(this, cb);
      else cb();
    }, callback);
  }

  run() {
    this.lastTimestamp = 0;
    this.accumulatedTime = 0;
    this.canvas.focus();
    this.tick();
  }

  tick = (timestamp = 0) => {
    this.tickAnimationFrameId = requestAnimationFrame(this.tick);

    this.accumulatedTime += timestamp - this.lastTimestamp;
    this.lastTimestamp = timestamp;

    let { updates, timeLeft } = this.gameInstance.tick(this.accumulatedTime);
    this.accumulatedTime = timeLeft;
    if (this.gameInstance.input.exited) { cancelAnimationFrame(this.tickAnimationFrameId); return; }

    if (updates > 0) this.gameInstance.draw();
  };

  getAssetData(path: string, responseType: string, callback: (err: Error, data?: any) => any) {
    supFetch(`${this.dataURL}${path}`, responseType, callback);
  }

  getOuterAsset(assetId: number) {
    let outerAsset = this.outerAssetsById[assetId];
    let asset = this.assetsById[assetId];
    let entry = this.entriesById[assetId];

    if (outerAsset == null && asset != null) {
      if (entry.type == null) {
        outerAsset = { name: entry.name, path: entry.path, type: "folder", children: entry.children };
      }
      else {
        let plugin = SupRuntime.plugins[this.entriesById[assetId].type];
        outerAsset = this.outerAssetsById[assetId] =
          // Temporary check until every asset is correctly handled
          (plugin.createOuterAsset != null) ? plugin.createOuterAsset(this, asset) : asset;

        outerAsset.name = entry.name;
        outerAsset.path = entry.path;
        outerAsset.type = entry.type;
      }
    }

    return outerAsset;
  }

  createActor() { throw new Error("Player.createActor should be defined by a scripting plugin"); }
  createComponent() { throw new Error("Player.createComponent should be defined by a scripting plugin"); }
}
