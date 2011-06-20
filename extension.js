const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const St = imports.gi.St;

const Main = imports.ui.main;
const Workspace = imports.ui.workspace;
const WorkspacesView = imports.ui.workspacesView;

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

	// WORKSPACE PATCHES //
	
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
		//global.log(visibleClones.length);
		for (let i = 0; i < visibleClones.length; i++) {
			//global.log(slots[i][0]);
			//global.log(slots[i][1]);
			if (y == slots[i][1] && firstRow) {
				++cols;
			} else {
				firstRow = false;
			}
			let clone = visibleClones[i];
			let metaWindow = clone.metaWindow;
			//global.log(metaWindow.title);
	        let mainIndex = this._lookupIndex(metaWindow);
		}
	    this.geometryDict.cols = cols;
	});
	
    Workspace.Workspace.prototype.getVisibleClone = function(index) {
    	let visibleClones = this._windows.slice();
        if (this._reservedSlot) {
        	visibleClones.push(this._reservedSlot);
        }
        let slots = this._computeAllWindowSlots(visibleClones.length);
        visibleClones = this._orderWindowsByMotionAndStartup(visibleClones, slots);
        return visibleClones[index];
    }
    
	// WORKSPACESVIEW PATCHES //
    
    injectToFunction(WorkspacesView.WorkspacesView.prototype, '_init', function(width, height, x, y, workspaces) {
        this._arrowKeyIndex = 0;
        this._prevSelectedWin = null;
        this._arrowKeyPressEventId = global.stage.connect('key-press-event', Lang.bind(this, this._onArrowKeyPress));
    });
    
    injectToFunction(WorkspacesView.WorkspacesView.prototype, '_onDestroy', function() {
        global.stage.disconnect(this._arrowKeyPressEventId);
    });
    
    WorkspacesView.WorkspacesView.prototype._nonArrowKeyPressed = function(key, workspace) {
    	if (key == Clutter.Return) {
            let win = workspace.getVisibleClone(this._arrowKeyIndex);
            if (win) {
                Main.activateWindow(win.metaWindow, global.get_current_time());
             }
        } else if (key == Clutter.Control_R && this._prevSelectedWin) {
        	this._prevSelectedWin._zoomEnd();
        	this._prevSelectedWin = null;
        	this._arrowKeyIndex = 0;
        }
    }
    
    WorkspacesView.WorkspacesView.prototype._arrowKeyPressed = function(key, workspace) {
    	let cols = workspace.geometryDict.cols;
        if (this._prevSelectedWin) {
        	this._prevSelectedWin._zoomEnd();
            if (key == Clutter.Up) {
            	this._arrowKeyIndex -= cols;
            } else if (key == Clutter.Down) {
            	this._arrowKeyIndex += cols;
            } else if (key == Clutter.Left) {
                --this._arrowKeyIndex;
            } else if (key == Clutter.Right) {
                ++this._arrowKeyIndex;
            }
        } 
        this._prevSelectedWin = workspace.getVisibleClone(this._arrowKeyIndex);
        this._prevSelectedWin.zoomSelected();
    }
    
    WorkspacesView.WorkspacesView.prototype._onArrowKeyPress = function(s, o) {
        let key = o.get_key_symbol();
        let active = global.screen.get_active_workspace_index();
        let workspace = this._workspaces[active];
        if (key != Clutter.Up && key != Clutter.Down && key != Clutter.Left && key != Clutter.Right) {
            this._nonArrowKeyPressed(key, workspace);
            return false;
        } else {
        	this._arrowKeyPressed(key, workspace);
        	return true;
        }
    }

    // WINDOWCLONE PATCHES //
    
    Workspace.WindowClone.prototype.zoomSelected = function() {
        this._zoomStart();
        this._zoomStep += 25;
        this._zoomUpdate();
    }
}


