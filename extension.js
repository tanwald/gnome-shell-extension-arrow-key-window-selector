/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const St = imports.gi.St;

const Main = imports.ui.main;
const Workspace = imports.ui.workspace;
const WorkspacesView = imports.ui.workspacesView;
const Overview = imports.ui.overview;
const Lightbox = imports.ui.lightbox;
const ScaledPoint = Workspace.ScaledPoint;
const Tweener = imports.ui.tweener;

/*
 * Helper function for injecting code into existing
 * functions. Taken from other extensions.
 * @param parent: parent class
 * @param name: name of the function
 * @param func: function which is to be injected
 * @return: return-value of original or injected function
 */
function injectToFunction(parent, name, func) {
    let origin = parent[name];
    parent[name] = function() {
        let ret;
        ret = origin.apply(this, arguments);
        if (ret === undefined) ret = func.apply(this, arguments);
        return ret;
    }
}

// I swapped the last two slots in case 4 to provide increasing x-coordinates (to be consistent). 
const PATCHED_POSITIONS = {
        1: [[0.5, 0.5, 0.95]],
        2: [[0.25, 0.5, 0.48], [0.75, 0.5, 0.48]],
        3: [[0.25, 0.25, 0.48], [0.75, 0.25, 0.48], [0.5, 0.75, 0.48]],
        4: [[0.25, 0.25, 0.47], [0.75, 0.25, 0.47], [0.25, 0.75, 0.47], [0.75, 0.75, 0.47]],
        5: [[0.165, 0.25, 0.32], [0.495, 0.25, 0.32], [0.825, 0.25, 0.32], [0.25, 0.75, 0.32], [0.75, 0.75, 0.32]]
};

function main() {
    
    /*
     * Introduces two additional members.
     */
    injectToFunction(Workspace.Workspace.prototype, '_init', function(metaWorkspace) {
        // Contains information about the geometric arrangement of window-clones 
        // which are displayed in overview mode.
        this._geometryDict = {};
        // Window-clones in the same order as they are inserted into the 
        // overview grid.
        this._sortedClones = [];
    });

    /*
     * Retrieves and stores information about the geometric arrangement of window-clones.
     * This information has to be updated each time 'positionWindows' is called.
     */
    injectToFunction(Workspace.Workspace.prototype, 'positionWindows', function(flags) {
        let [sortedClones, slots] = this.getSortedClonesAndSlots();
        
        let prevY = slots[0][1];
        let cols = 0;
        let rows = 1;
        let first = true;
        // Get the number of columns i.e. the number of slots with identical y-coordinate
        // and the number of rows.
        for (i in slots) {
            if (prevY == slots[i][1] && first) {
                ++cols;
            } else {
                first = false;
                ++rows;
            }
        }
        this._geometryDict.cols = cols;
        this._geometryDict.rows = rows;
        this._geometryDict.maxWindowIndex = sortedClones.length - 1;
        this._geometryDict.maxGridIndex = cols * rows - 1;
        this._sortedClones = sortedClones;
    });
    
    /*
     * Getter for _geometryDict.
     * @return: Object
     */
    Workspace.Workspace.prototype.getGeometryDict = function() {
        return this._geometryDict;
    }
    
    /*
     * Getter for a window clone within _sortedClones.
     * @param index: index of the desired window clone
     * @return: WindowClone
     */
    Workspace.Workspace.prototype.getWindowClone = function(index) {
        return this._sortedClones[index];
    }
    
    /*
     * Getter for all sorted window clones.
     * @return: [ WindowClone ]
     */
    Workspace.Workspace.prototype.getWindowClones = function() {
        return this._sortedClones;
    }
    
    /*
     * Returns an array of window-clones in the same order as they are inserted into the 
     * overview grid and a second array containing their slots in corresponding order.
     * @return: [ [ WindowClone ], [ Slot ] ]
     */
    Workspace.Workspace.prototype.getSortedClonesAndSlots = function() {
        // create a copy of all window clones.
        let sortedClones = this._windows.slice();
        if (this._reservedSlot) {
            sortedClones.push(this._reservedSlot);
        }
        let slots = this._computeAllWindowSlots(sortedClones.length);
        // sort window clones.
        sortedClones = this._orderWindowsByMotionAndStartup(sortedClones, slots);
        return [sortedClones, slots];
    }
    
    /*
     * Overrides the original implementation because of an inconsistency in the arrangement
     * of slots/window-clones.
     * @attention: this could be removed if the constant variable POSITIONS was adjusted
     */
    Workspace.Workspace.prototype._computeWindowSlot = function(windowIndex, numberOfWindows) {
        let POSITIONS = PATCHED_POSITIONS;
        if (numberOfWindows in POSITIONS) return POSITIONS[numberOfWindows][windowIndex];
        
        let gridWidth = Math.ceil(Math.sqrt(numberOfWindows));
        let gridHeight = Math.ceil(numberOfWindows / gridWidth);
        let fraction = 0.95 * (1. / gridWidth);
        let xCenter = (.5 / gridWidth) + ((windowIndex) % gridWidth) / gridWidth;
        let yCenter = (.5 / gridHeight) + Math.floor((windowIndex / gridWidth)) / gridHeight;
        return [xCenter, yCenter, fraction];
    },
    
    /*
     * Introduces three additional members and registers a 'key-press-event' listener.
     */
    injectToFunction(WorkspacesView.WorkspacesView.prototype, '_init', function(width, height, x, y, workspaces) {
        this._arrowKeyPressEventId = global.stage.connect('key-press-event', Lang.bind(this, this._onAnyKeyPress));
        this._arrowKeyIndex = 0;
        this._selectedWin = null;
        this._lightBox = null;
    });
    
    /*
     * Disconnects the 'key-press-event' listener and ends the selection process
     * if it was canceled with the super-key.
     * @TODO: capture the super-key-pressed event directly.
     */
    injectToFunction(WorkspacesView.WorkspacesView.prototype, '_onDestroy', function() {
        global.stage.disconnect(this._arrowKeyPressEventId);
        this._endSelection();
    });
    
    /*
     * Callback function that is triggered by 'key-press-events' and delegates to the 
     * according subroutines.
     * @param s: signal ?!?
     * @param o: event object 
     * @return: Boolean
     */
    WorkspacesView.WorkspacesView.prototype._onAnyKeyPress = function(s, o) {
        let key = o.get_key_symbol();
        let workspace = this.getActiveWorkspace();
        // Check if an arrow key was pressed
        if (key == Clutter.Up || key == Clutter.Down || key == Clutter.Left || key == Clutter.Right) {
            this._arrowKeyPressed(key, workspace);
            return true;
        } else {
            this._nonArrowKeyPressed(key, workspace);
            return false;
        }
    }
    
    /*
     * Entry point for the selection process by arrow keys
     * @param key: pressed key
     * @param workspace: the active workspace
     */
    WorkspacesView.WorkspacesView.prototype._arrowKeyPressed = function(key, workspace) {
        // If this method has already been called before, we already have a selected window.
        if (this._selectedWin) {
            // We have to unselect the previous window...
            this._selectedWin.unselect();
            // ... and compute the new window index.
            this._updateArrowKeyIndex(key, workspace);
        // Otherwise we have to initialize the selection process.
        } else {
            this._initSelection(workspace);
        }
        
        // Define the new selected window and highlight it.
        this._selectedWin = workspace.getWindowClone(this._arrowKeyIndex);
        this._selectedWin.select(this._lightBox);
    }
    
    /*
     * Activates the currently selected window and/or ends the selection process.
     * @param key: pressed key
     * @param workspace: the active workspace
     */
    WorkspacesView.WorkspacesView.prototype._nonArrowKeyPressed = function(key, workspace) {
        if (this._selectedWin && key == Clutter.Return) {
            let win = workspace.getWindowClone(this._arrowKeyIndex);
            if (win) {
                this._endSelection();
                Main.activateWindow(win.metaWindow, global.get_current_time());
             }
        } else {
            this._endSelection();
        }
    }
    
    /*
     * Contains all the logic for selecting a new window based on arrow key input.
     * @param key: pressed key
     * @param workspace: the active workspace
     */
    WorkspacesView.WorkspacesView.prototype._updateArrowKeyIndex = function(key, workspace) {
        let cols = workspace.getGeometryDict().cols;
        let maxWindowIndex = workspace.getGeometryDict().maxWindowIndex;
        let maxGridIndex = workspace.getGeometryDict().maxGridIndex;
        let prevArrowKeyIndex = this._arrowKeyIndex;
        
        if (key == Clutter.Up) {
            this._arrowKeyIndex -= cols;
        } else if (key == Clutter.Down) {
            this._arrowKeyIndex += cols;
        } else if (key == Clutter.Left) {
            --this._arrowKeyIndex;
        } else if (key == Clutter.Right) {
            ++this._arrowKeyIndex;
        }
        
        // Handle navigation attempts that would go beyond the window grid.
        if (this._arrowKeyIndex < 0) this._arrowKeyIndex = prevArrowKeyIndex;
        if (this._arrowKeyIndex > maxWindowIndex) {
            this._arrowKeyIndex = (this._arrowKeyIndex <= maxGridIndex) ? maxWindowIndex : prevArrowKeyIndex;
        }
    }
    
    /*
     * Adds a lightbox to the main ui group and sets focus to the active window.
     */
    WorkspacesView.WorkspacesView.prototype._initSelection = function(workspace) {
        this._lightBox = new Lightbox.Lightbox(Main.uiGroup, {fadeTime: 0.1});
        this._lightBox.show();
        let wins = workspace.getWindowClones();
        let focus = global.screen.get_display().focus_window;
        for (i in wins) {
            if (wins[i].metaWindow == focus) this._arrowKeyIndex = i;
        }
    }
    
    /*
     * Tidy up all actors and adjustments that were introduced during the
     * selection process.
     */
    WorkspacesView.WorkspacesView.prototype._endSelection = function() {
        if (this._selectedWin) {
            this._selectedWin.unselect();
            this._selectedWin = null;
            this._lightBox.hide();
            this._lightBox.destroy();
            this._lightBox = null;
            this._arrowKeyIndex = 0;
        }
    }
    
    /*
     * Ends the scroll-zooming process when you want to start selecting.
     */
    injectToFunction(Workspace.WindowClone.prototype, '_init', function(realWindow) {
        this._arrowKeyPressEventId = global.stage.connect('key-press-event', Lang.bind(this, this._zoomEnd));
    });
    
    /*
     * Disconnects the key-press-event listener.
     */
    injectToFunction(Workspace.WindowClone.prototype, '_onDestroy', function() {
        global.stage.disconnect(this._arrowKeyPressEventId);
    });
    
    /*
     * Highlights and zooms the currently selected window.
     * @param lightBox: a reference to the lightbox introduced by _initSelection
     */
    Workspace.WindowClone.prototype.select = function(lightBox) {
        // Store the original geometry and highlight the window.
        this._origScaledPoint  = new ScaledPoint(this.actor.x, this.actor.y, this.actor.scale_x, this.actor.scale_y);
        this._origParent = this.actor.get_parent();
        this.actor.reparent(Main.uiGroup);
        this.actor.raise_top();
        lightBox.highlight(this.actor);
        
        // Calculate the new geometry.
        let new_scale_x = this.actor.scale_x * 1.5;
        let new_scale_y = this.actor.scale_y * 1.5;
        let new_width = this.actor.width * new_scale_x;
        let new_height = this.actor.height * new_scale_y;
        let delta_width =  new_width - this.actor.width * this.actor.scale_x;
        let delta_height = new_height - this.actor.height * this.actor.scale_y;
        let new_x = this.actor.x - delta_width / 2;
        let new_y = this.actor.y - delta_height / 2;
        
        // Define available Area.
        let monitorIndex = this.metaWindow.get_monitor();
        let availArea = global.get_monitors()[monitorIndex];
        let padding = 50;
        let top = availArea.y + padding;
        let bottom = availArea.y + availArea.height - padding;
        let left = availArea.x + padding;
        let right = availArea.x + availArea.width - padding;
        
        // Adjust new geometry to the available Area.
        if (monitorIndex == global.get_primary_monitor_index()) top += Main.panel.actor.height;
        if (new_x + new_width > right) new_x = right - new_width;
        if (new_x < left) new_x = left;
        if (new_y + new_height > bottom) new_y = bottom - new_height;
        if (new_y < top) new_y = top;
        
        // Zoom the window.
        Tweener.addTween(this.actor,
                { x: new_x,
                  y: new_y,
                  scale_x: new_scale_x,
                  scale_y: new_scale_y,
                  time: 0.5,
                  transition: 'easeOutQuad' 
                });
    }
    
    /*
     * Undoes the adjustments done by select().
     */
    Workspace.WindowClone.prototype.unselect = function() {
        Tweener.removeTweens(this.actor);
        this.actor.reparent(this._origParent);
        [this.actor.x, this.actor.y] = this._origScaledPoint.getPosition();
        [this.actor.scale_x, this.actor.scale_y] = this._origScaledPoint.getScale();
    }
}

