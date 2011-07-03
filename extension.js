/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;

const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;
const Workspace = imports.ui.workspace;
const WorkspacesView = imports.ui.workspacesView;

/*
 * Helper function for injecting code into existing
 * functions. Taken from other extensions.
 * @param parent: Parent class.
 * @param name: Name of the function.
 * @param func: Function which is to be injected.
 * @return: Return-value of the original or injected function.
 */
function injectToFunction(parent, name, func) {
    let origin = parent[name];
    parent[name] = function() {
        let ret;
        ret = origin.apply(this, arguments);
        if (ret === undefined) {
            ret = func.apply(this, arguments);
        }
        return ret;
    }
}

function main() {

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// WorkspaceView ////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Introduces four additional members and registers a 'key-press-event' listener.
     */
    injectToFunction(WorkspacesView.WorkspacesView.prototype, '_init', function(width, height, x, y, workspaces) {
        this._anyKeyPressEventId = global.stage.connect('key-press-event', Lang.bind(this, this._onAnyKeyPress));
        // Index of the window that is - or is to be - selected.
        this._arrowKeyIndex = 0;
        // The currently selected window. Actually it's the window overlay because it 
        // contains the most information and has access to other abstractions.
        this._selected = null;
        this._lightbox = null;
    });
    
    /*
     * Disconnects the 'key-press-event' listener and ends the selection process
     * if it was canceled by the super-key.
     */
    injectToFunction(WorkspacesView.WorkspacesView.prototype, '_onDestroy', function() {
        global.stage.disconnect(this._anyKeyPressEventId);
        this._endSelection(false);
    });
    
    /*
     * Callback function that is triggered by 'key-press-events' and delegates to the 
     * according subroutines.
     * @param actor: Actor which emits the event.
     * @param event: The event object. 
     * @return: Boolean.
     */
    WorkspacesView.WorkspacesView.prototype._onAnyKeyPress = function(actor, event) {
        let key = event.get_key_symbol();
        if (key == Clutter.Up || key == Clutter.Down || key == Clutter.Left || key == Clutter.Right) {
            return this._arrowKeyPressed(key);
        } else {
            return this._nonArrowKeyPressed(key);
        }
    }
    
    /*
     * Entry point for the selection process by arrow keys.
     * @param key: Pressed key.
     * @return: Boolean.
     */
    WorkspacesView.WorkspacesView.prototype._arrowKeyPressed = function(key) {
        let windowOverlays = this.getWindowOverlays();
        // Stop immediately if there are no windows.
        if (windowOverlays.all().length < 1) {
            return false;
        // If this method has been called before, we already have a selected window.
        } else if (this._selected) {
            this._updateArrowKeyIndex(key, windowOverlays.all());
            this._selected.unselect(true);
        // Otherwise we have to initialize the selection process.
        } else {
            this._initSelection(windowOverlays.all());
        }
        // Define the new/initially selected window and highlight it.
        this._selected = windowOverlays.at(this._arrowKeyIndex);
        this._selected.select(this._lightbox, windowOverlays.all().length);
        return true;
    }
    
    /*
     * Activates/closes the currently selected window and/or ends the selection process.
     * @param key: Pressed key.
     * @return: Boolean.
     */
    WorkspacesView.WorkspacesView.prototype._nonArrowKeyPressed = function(key) {
        if (this._selected && key == Clutter.Return) {
            let metaWindow = this.getWindowOverlays().at(this._arrowKeyIndex).getMetaWindow();
            this._endSelection(false);
            Main.activateWindow(metaWindow, global.get_current_time());
        } else if (this._selected && key == Clutter.Delete) {
            let windowOverlay = this.getWindowOverlays().at(this._arrowKeyIndex);
            this._endSelection(false);
            windowOverlay.closeWindow();
        } else {
            this._endSelection(true);
        }
        return false;
    }
    
    /*
     * Contains all the logic for selecting a new window based on arrow key input.
     * @param key: Pressed key.
     * @param windowOverlays: Window overlays of the active workspace and extra workspaces.
     */
    WorkspacesView.WorkspacesView.prototype._updateArrowKeyIndex = function(key, windowOverlays) {
        // sw ... selected window.
        // cw ... current window.
        sw = this._selected.getStoredGeometry();
        // Just in case some user has infinite resolution...
        let minDistance = Number.POSITIVE_INFINITY;
        if (key == Clutter.Up) {
            for (i in windowOverlays) {
                let cw = windowOverlays[i].getStoredGeometry();
                let distance = this._calcDistance(sw, cw);
                if (cw.y + cw.height < sw.y && distance < minDistance) {
                    this._arrowKeyIndex = i;
                    minDistance = distance;
                }
            }
        } else if (key == Clutter.Down) {
            for (i in windowOverlays) {
                let cw = windowOverlays[i].getStoredGeometry();
                let distance = this._calcDistance(sw, cw);
                if (cw.y > sw.y + sw.height && distance < minDistance) {
                    this._arrowKeyIndex = i;
                    minDistance = distance;
                }
            }
        } else if (key == Clutter.Left) {
            for (i in windowOverlays) {
                let cw = windowOverlays[i].getStoredGeometry();
                let distance = this._calcDistance(sw, cw);
                if (cw.x + cw.width < sw.x && distance < minDistance) {
                    this._arrowKeyIndex = i;
                    minDistance = distance;
                }
            }
        } else if (key == Clutter.Right) {
            for (i in windowOverlays) {
                let cw = windowOverlays[i].getStoredGeometry();
                let distance = this._calcDistance(sw, cw);
                if (cw.x > sw.x + sw.width && distance < minDistance) {
                    this._arrowKeyIndex = i;
                    minDistance = distance;
                }
            }
        }
    }
    
    /*
     * Calculates the Manhattan-Distance of two windows in overview mode. 
     * @param sw: Selected window.
     * @param cw: Currently evaluated window.
     * @return: Number.
     */
    WorkspacesView.WorkspacesView.prototype._calcDistance = function(sw, cw) {
        return Math.abs(sw.center_x - cw.center_x) + Math.abs(sw.center_y - cw.center_y);
    }
    
    /*
     * Adds a lightbox to the main ui group, sets focus to the active window
     * and stores the window geometry of clones. Motion- and button-press-event 
     * listeners assure that the selection process gets terminated if the user wants
     * to do something else.
     * @param windowOverlays: Window overlays of the active workspace and extra workspaces.
     */
    WorkspacesView.WorkspacesView.prototype._initSelection = function(windowOverlays) {
        this._anyButtonPressEventId = global.stage.connect('button-press-event', Lang.bind(this, this._endSelectionForListener));
        this._anyMotionEventId = global.stage.connect('motion-event', Lang.bind(this, this._endSelectionForListener));
        this._lightbox = new Lightbox.Lightbox(Main.uiGroup, {fadeTime: 0.1});
        this._lightbox.show();
        let focus = global.screen.get_display().focus_window;
        for (i in windowOverlays) {
            if (windowOverlays[i].getMetaWindow() == focus) {
                this._arrowKeyIndex = i;
            }
            windowOverlays[i].getWindowClone().createGeometrySnapshot();
        }
    }
    
    /*
     * Tidy up all actors and adjustments that were introduced during the
     * selection process.
     * @param resetGeometry: Flag which indicates if the geometry of the 
     * selected window should be reset.
     */
    WorkspacesView.WorkspacesView.prototype._endSelection = function(resetGeometry) {
        // As this method is also called each time the WorkpaceView is destroyed,
        // we have to check if a window was selected.
        if (this._selected) {
            global.stage.disconnect(this._anyButtonPressEventId);
            global.stage.disconnect(this._anyMotionEventId);
            this._selected.unselect(resetGeometry);
            this._selected = null;
            this._lightbox.hide();
            this._lightbox.destroy();
            this._lightbox = null;
            this._arrowKeyIndex = 0;
        }
    }
    
    /*
     * See WorkspacesView._endSelection. Always resets geometry.
     */
    WorkspacesView.WorkspacesView.prototype._endSelectionForListener = function() {
        this._endSelection(true);
    }
    
    /*
     * Getter for window overlays of the active workspace and surrounding 
     * extra workspaces on different monitors.
     * @return: { all(): [ WindowOverlay ], at(index): WindowOverlay }
     */
    WorkspacesView.WorkspacesView.prototype.getWindowOverlays = function() {
        let windowOverlays = this.getActiveWorkspace().getWindowOverlays();
        for (i in this._extraWorkspaces) {
            let extraWindowOverlays = this._extraWorkspaces[i].getWindowOverlays().all();
            for (j in extraWindowOverlays) {
                windowOverlays.push(extraWindowOverlays[j]);
            }
        }
        return {
            all: function() {
                return windowOverlays.all();
            },
            at: function(index) {
                return windowOverlays.at(index);
            }
        };
    }

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Workspace ////////////////////////////////////////////////////////////////////////////////////////////////////////   
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Getter for window overlays of a workspace. After the initial call additional window
     * overlays can be added.
     * @return: { all(): [ WindowOverlay ], at(index): WindowOverlay, push(WindowOverlay): Number }
     */
    Workspace.Workspace.prototype.getWindowOverlays = function() {
        let windowOverlays = this._windowOverlays;
        return {
            all: function() {
                return windowOverlays;
            },
            at: function(index) {
                return windowOverlays[index];
            },
            push: function(windowOverlay) {
                return windowOverlays.push(windowOverlay);
            }
        };
    }
    
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////// 
// WindowClone //////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Introduces a dictionary for window geometry and registers a key-press-event listener 
     * for terminating the scroll-zooming process when you want to start selecting.
     */
    injectToFunction(Workspace.WindowClone.prototype, '_init', function(realWindow) {
        this._anyKeyPressEventId = global.stage.connect('key-press-event', Lang.bind(this, this._zoomEnd));
        this.storedGeometry = {};
    });
    
    /*
     * Disconnects the key-press-event listener.
     */
    injectToFunction(Workspace.WindowClone.prototype, '_onDestroy', function() {
        global.stage.disconnect(this._anyKeyPressEventId);
    });
    
    /*
     * Highlights and zooms the currently selected window.
     * @param lightbox: A reference to the lightbox introduced by WorkspacesView._initSelection.
     * @param windowCount: Number of windows on the active workspace.
     */
    Workspace.WindowClone.prototype.select = function(lightbox, windowCount) {
        // Store the original parent and highlight the window.
        this._origParent = this.actor.get_parent();
        this.actor.reparent(Main.uiGroup);
        this.actor.raise_top();
        lightbox.highlight(this.actor);
        // Calculate the new geometry.
        let factor = (windowCount > 1) ? 1.3 : 1.1;
        let new_scale_x = this.actor.scale_x * factor;
        let new_scale_y = this.actor.scale_y * factor;
        let new_width = this.actor.width * new_scale_x;
        let new_height = this.actor.height * new_scale_y;
        let delta_width =  new_width - this.actor.width * this.actor.scale_x;
        let delta_height = new_height - this.actor.height * this.actor.scale_y;
        let new_x = this.actor.x - delta_width / 2;
        let new_y = this.actor.y - delta_height / 2;
        // Define the available Area.
        let monitorIndex = this.metaWindow.get_monitor();
        let availArea = global.get_monitors()[monitorIndex];
        let padding = 50;
        let top = availArea.y + padding;
        let bottom = availArea.y + availArea.height - padding;
        let left = availArea.x + padding;
        let right = availArea.x + availArea.width - padding;
        // Adjust the new geometry to the available Area.
        if (monitorIndex == global.get_primary_monitor_index()) {
            top += Main.panel.actor.height;
        }
        if (new_x + new_width > right) {
            new_x = right - new_width;
        }
        if (new_x < left){
            new_x = left;
        }
        if (new_y + new_height > bottom) {
            new_y = bottom - new_height;
        }
        if (new_y < top) {
            new_y = top;
        }
        // Zoom the window.
        Tweener.addTween(this.actor, { 
            x: new_x,
            y: new_y,
            scale_x: new_scale_x,
            scale_y: new_scale_y,
            time: 0.2,
            transition: 'easeOutQuad' 
        });
    }
    
    /*
     * Undoes the adjustments done by WindowClone.select.
     * @param resetGeometry: Flag which indicates if the geometry 
     * should be reset.
     */
    Workspace.WindowClone.prototype.unselect = function(resetGeometry) {
        Tweener.removeTweens(this.actor);
        this.actor.reparent(this._origParent);
        if (this._stackAbove == null) {
            this.actor.lower_bottom();
        } else if (this._stackAbove.get_parent()) {
            this.actor.raise(this._stackAbove);
        }
        if (resetGeometry) {
            this.actor.x = this.storedGeometry.x; 
            this.actor.y = this.storedGeometry.y;
            this.actor.scale_x = this.storedGeometry.scale_x;
            this.actor.scale_y = this.storedGeometry.scale_y; 
        }
    }
    
    /*
     * Creates a snapshot of the window geometry.
     */
    Workspace.WindowClone.prototype.createGeometrySnapshot = function() {
        let width = this.actor.width * this.actor.scale_x;
        let height = this.actor.height * this.actor.scale_y;
        this.storedGeometry = {
            x: this.actor.x, 
            y: this.actor.y,
            width: width,
            height: height, 
            scale_x: this.actor.scale_x,
            scale_y: this.actor.scale_y,
            center_x: this.actor.x + width / 2,
            center_y: this.actor.y + height / 2
        };
    }
    
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////   
// WindowOverlay ////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /*
     * Selects the associated window. See WindowClone.select.
     * @param lightbox: A reference to the lightbox introduced by WorkspacesView._initSelection.
     * @param windowCount: Number of windows on the active workspace.
     */
    Workspace.WindowOverlay.prototype.select = function(lightbox, windowCount) {
        this.hide();
        this._windowClone.select(lightbox, windowCount);
    }
    
    /*
     * Unselects the associated window. See WindowClone.unselect.
     * @param resetGeometry: Flag which indicates if the geometry 
     * should be reset.
     */
    Workspace.WindowOverlay.prototype.unselect = function(resetGeometry) {
        this.show();
        this._windowClone.unselect(resetGeometry);
    }
    
    /*
     * Closes the associated window.
     */
    Workspace.WindowOverlay.prototype.closeWindow = function() {
        this._closeWindow(null);
    }
    
    /*
     * Returns a geometry-info object of the window clone.
     * @return: Object.
     */
    Workspace.WindowOverlay.prototype.getStoredGeometry = function() {
        return this._windowClone.storedGeometry;
    }
    
    /*
     * Getter for the window clone.
     * @return: WindowClone.
     */
    Workspace.WindowOverlay.prototype.getWindowClone = function() {
        return this._windowClone;
    }
    
    /*
     * Getter for the meta window.
     * @return: MetaWindow.
     */
    Workspace.WindowOverlay.prototype.getMetaWindow = function() {
        return this._windowClone.metaWindow;
    }
}

