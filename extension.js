/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const St = imports.gi.St;

const Main = imports.ui.main;
const Workspace = imports.ui.workspace;
const WorkspacesView = imports.ui.workspacesView;

/*
 * Helper function for injecting code into existing
 * functions. Taken from other extensions.
 * @param parent: parent class
 * @param name: name of the function
 * @param func: function which is to be injected
 */
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

    /* 
     * ************************************************************************************
     * Workspace patches
     * ************************************************************************************
     */
    
    /*
     * Declares two additional members.
     * @param metaWorkspace: for compatibility 
     */
    injectToFunction(Workspace.Workspace.prototype, '_init', function(metaWorkspace) {
        // Contains information about the geometric arrangement of window-clones 
        // which are displayed in overview mode.
        this.geometryDict = {};
        // Window-clones in the same order as they are inserted into the 
        // overview grid.
        this.sortedClones = [];
    });

    /*
     * Retrieves and stores information about the geometric arrangement of window-clones.
     * @param flags: for compatibility
     */
    injectToFunction(Workspace.Workspace.prototype, 'positionWindows', function(flags) {
        let [sortedClones, slots] = this.getSortedClonesAndSlots();
        let prevY = slots[0][1];
        let cols = 0, first = true;
        // Get the number of columns ie the number of slots with identical y-coordinate.
        for (let i = 0; i < slots.length && first; ++i) {
            (prevY == slots[i][1]) ? ++cols : first = false;
        }
        this.geometryDict.cols = cols;
        this.geometryDict.maxIndex = sortedClones.length - 1;
        this.sortedClones = sortedClones;
    });
    
    /*
     * Returns an array of window-clones in the same order as they are inserted into the 
     * overview grid and a second array containing their slots in corresponding order.
     * @return: [sortedClones, slots]
     */
    Workspace.Workspace.prototype.getSortedClonesAndSlots = function() {
        let sortedClones = this._windows.slice();
        if (this._reservedSlot) {
            sortedClones.push(this._reservedSlot);
        }
        let slots = this._computeAllWindowSlots(sortedClones.length);
        sortedClones = this._orderWindowsByMotionAndStartup(sortedClones, slots);
        return [sortedClones, slots];
    }
    
    /*
     * Overrides the original implementation because of an inconsistency in the arrangement
     * of slots/window-clones.
     * @attention: this could be removed if the constant variable POSITIONS was adjusted
     */
    Workspace.Workspace.prototype._computeWindowSlot = function(windowIndex, numberOfWindows) {
        let PATCHED_POSITIONS = {
                1: [[0.5, 0.5, 0.95]],
                2: [[0.25, 0.5, 0.48], [0.75, 0.5, 0.48]],
                3: [[0.25, 0.25, 0.48], [0.75, 0.25, 0.48], [0.5, 0.75, 0.48]],
                // Swapped the last two slots to provide increasing x-coordinates (to be consistent). 
                4: [[0.25, 0.25, 0.47], [0.75, 0.25, 0.47], [0.25, 0.75, 0.47], [0.75, 0.75, 0.47]],
                5: [[0.165, 0.25, 0.32], [0.495, 0.25, 0.32], [0.825, 0.25, 0.32], [0.25, 0.75, 0.32], [0.75, 0.75, 0.32]]
        };
        if (numberOfWindows in PATCHED_POSITIONS)
            return PATCHED_POSITIONS[numberOfWindows][windowIndex];
        let gridWidth = Math.ceil(Math.sqrt(numberOfWindows));
        let gridHeight = Math.ceil(numberOfWindows / gridWidth);
        let fraction = 0.95 * (1. / gridWidth);
        let xCenter = (.5 / gridWidth) + ((windowIndex) % gridWidth) / gridWidth;
        let yCenter = (.5 / gridHeight) + Math.floor((windowIndex / gridWidth)) / gridHeight;
        return [xCenter, yCenter, fraction];
    },
    
    /* 
     * ************************************************************************************
     * WorkspaceView patches
     * ************************************************************************************
     */
    
    injectToFunction(WorkspacesView.WorkspacesView.prototype, '_init', function(width, height, x, y, workspaces) {
        this._arrowKeyIndex = 0;
        this._prevSelectedWin = null;
        this._arrowKeyPressEventId = global.stage.connect('key-press-event', Lang.bind(this, this._onArrowKeyPress));
    });
    
    injectToFunction(WorkspacesView.WorkspacesView.prototype, '_onDestroy', function() {
        global.stage.disconnect(this._arrowKeyPressEventId);
    });
    
    WorkspacesView.WorkspacesView.prototype._onArrowKeyPress = function(s, o) {
        let key = o.get_key_symbol();
        let workspace = this.getActiveWorkspace();
        if (key == Clutter.Up || key == Clutter.Down || key == Clutter.Left || key == Clutter.Right) {
            this._arrowKeyPressed(key, workspace);
            return true;
        } else {
            this._nonArrowKeyPressed(key, workspace);
            return false;
        }
    }
    
    WorkspacesView.WorkspacesView.prototype._arrowKeyPressed = function(key, workspace) {
        let cols = workspace.geometryDict.cols;
        let maxIndex = workspace.geometryDict.maxIndex;
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
        this._arrowKeyIndex = (this._arrowKeyIndex < 0) ? 0 : this._arrowKeyIndex;
        this._arrowKeyIndex = (this._arrowKeyIndex > maxIndex) ? maxIndex : this._arrowKeyIndex;
        this._prevSelectedWin = workspace.sortedClones[this._arrowKeyIndex];
        this._prevSelectedWin.zoomSelected();
    }
    
    WorkspacesView.WorkspacesView.prototype._nonArrowKeyPressed = function(key, workspace) {
        if (key == Clutter.Return) {
            let win = workspace.sortedClones[this._arrowKeyIndex];
            if (win) {
                Main.activateWindow(win.metaWindow, global.get_current_time());
             }
        } else if (this._prevSelectedWin) {
            this._prevSelectedWin._zoomEnd();
            this._prevSelectedWin = null;
            this._arrowKeyIndex = 0;
        }
    }
    
    /* 
     * ************************************************************************************
     * WindowClone patches
     * ************************************************************************************
     */
    
    Workspace.WindowClone.prototype.zoomSelected = function() {
        this._zoomStart();
        this._zoomStep += 25;
        this._zoomUpdate();
    }
    
    injectToFunction(Workspace.WindowClone.prototype, '_init', function(realWindow) {
        this._arrowKeyPressEventId = global.stage.connect('key-press-event', Lang.bind(this, this._zoomEnd));
    });
    
    injectToFunction(Workspace.WindowClone.prototype, '_onDestroy', function() {
        global.stage.disconnect(this._arrowKeyPressEventId);
    });
}

//let clone = sortedClones[i];
//let metaWindow = clone.metaWindow;
//global.log(metaWindow.title);
//let mainIndex = this._lookupIndex(metaWindow);
