const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const St = imports.gi.St;

const Main = imports.ui.main;
const Workspace = imports.ui.workspace;
const WorkspacesView = imports.ui.workspacesView;
const Tweener = imports.ui.tweener;

function injectToFunction(parent, name, func) {
    let origin = parent[name];
    parent[name] = function() {
        let ret;
        ret = origin.apply(this, arguments);
        if (ret === undefined)
            ret = func.apply(this, arguments);
        return ret;
    }
}

function main() {

    Workspace.Workspace.prototype.getMetaWindow = function(index) {
    	let visibleClones = this._windows.slice();
        if (this._reservedSlot) {
        	visibleClones.push(this._reservedSlot);
        }

        let slots = this._computeAllWindowSlots(visibleClones.length);
        visibleClones = this._orderWindowsByMotionAndStartup(visibleClones, slots);
        return visibleClones[index].metaWindow;
    }

    WorkspacesView.WorkspacesView.prototype._onArrowKeyPress = function(s, o) {
        let key = o.get_key_symbol();
        let active = global.screen.get_active_workspace_index();
        let workspace = this._workspaces[active];
        if (key != Clutter.Up && key != Clutter.Down && key != Clutter.Left && key != Clutter.Right) {
            if (key == Clutter.Return) {
                let win = workspace.getMetaWindow(this._arrowKeyIndex);
                if (win) {
                    Main.activateWindow(win, global.get_current_time());
                 }
            }
            return false;
        }
        let cols = workspace.geometryDict.cols;
        global.log(cols);
        if (key == Clutter.Up) {
        	this._arrowKeyIndex -= cols;
        } else if (key == Clutter.Down) {
        	this._arrowKeyIndex += cols;
        } else if (key == Clutter.Left) {
            --this._arrowKeyIndex;
        } else if (key == Clutter.Right) {
            ++this._arrowKeyIndex;
        }
        global.log(this._arrowKeyIndex);
        return true;
    }

    injectToFunction(Workspace.Workspace.prototype, '_init', function(metaWorkspace) {
       this.geometryDict = {};
    });

    injectToFunction(Workspace.Workspace.prototype, 'positionWindows', function(flags) {
        let visibleClones = this._windows.slice();
        if (this._reservedSlot) {
        	visibleClones.push(this._reservedSlot);
        }

        let slots = this._computeAllWindowSlots(visibleClones.length);
        visibleClones = this._orderWindowsByMotionAndStartup(visibleClones, slots);
        let y = slots[0][1];
        let cols = 0;
        let firstRow = true;
        
        for (let i = 0; i < visibleClones.length; i++) {
//        	global.log(slots[i][0]);
//        	global.log(slots[i][1]);
            if (y == slots[i][1] && firstRow) {
                ++cols;
            } else {
                firstRow = false;
            }
            let clone = visibleClones[i];
            let metaWindow = clone.metaWindow;
            let mainIndex = this._lookupIndex(metaWindow);
        }
        this.geometryDict.cols = cols;
    });

    injectToFunction(WorkspacesView.WorkspacesView.prototype, '_init', function(width, height, x, y, workspaces) {
        this._arrowKeyIndex = 0;
        this._arrowKeyPressEventId = global.stage.connect('key-press-event', Lang.bind(this, this._onArrowKeyPress));
    });
    
    injectToFunction(WorkspacesView.WorkspacesView.prototype, '_onDestroy', function() {
        global.stage.disconnect(this._arrowKeyPressEventId);
    });
}



