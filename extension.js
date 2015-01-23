/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const St = imports.gi.St;

const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const Overview = imports.ui.overview;
const Tweener = imports.ui.tweener;
const ViewSelector = imports.ui.viewSelector;
const Workspace = imports.ui.workspace;
const WorkspacesView = imports.ui.workspacesView;

const Extension = imports.misc.extensionUtils.getCurrentExtension();
const Utils = Extension.imports.utils;
const KeyCtrl = Extension.imports.keyctrl;

function enable() {
	
	let ext = new Utils.ExtHelper();
	let cfg = new KeyCtrl.KeyCtrlConfig();
    
////////////////////////////////////////////////////////////////////////////////
// WorkspacesDisplay ///////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Here we go...
     */
    ext.injectAfter(
        WorkspacesView.WorkspacesDisplay, 
        'show', 
        function() {
            // Kind of cache for all selectable windows.
            this._windowOverlaysActive = [];
            this._keyCtrl = new KeyCtrl.KeyCtrl(this, ext, cfg);
        }
    );
    
    /*
     * Here we leave...
     */
    ext.injectAfter(
        WorkspacesView.WorkspacesDisplay, 
        'hide', 
        function() {
            this._windowOverlaysActive = [];
            this._keyCtrl.sleep();
        }
    );
    
    /*
     * Getter for WindowOverlays of the active workspace and surrounding
     * extra workspaces on different monitors.
     * @return: [ WindowOverlay ]
     */
     ext.addMember(
         WorkspacesView.WorkspacesDisplay,
         'getWindowOverlays',
         function(upToDate) {
             let windowOverlays = [];
             if (upToDate) {
                 // Retrieve from "cache".
                 windowOverlays = this._windowOverlaysActive;
             } else {
                 this._workspacesViews.forEach(function(view) {
                     windowOverlays.push.apply(
                         windowOverlays,
                         view.getWindowOverlays()
                     );
                 })
                 this._windowOverlaysActive = windowOverlays;
             }
             return windowOverlays;
         }
     );
     
     /*
      * Returns the number of managed windows within the active workspace. 
      * @return: Number
      */
     ext.addMember(
         WorkspacesView.WorkspacesDisplay,
         'getWindowCount',
         function(upToDate) {
             return this.getWindowOverlays(upToDate).length;
         }
     );
 
////////////////////////////////////////////////////////////////////////////////
// WorkspacesView //////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
     
     /*
      * Disables the native window selection.
      */
     ext.injectAfter(
        WorkspacesView.WorkspacesViewBase, 
        '_init', 
        function() {
        	global.focus_manager.remove_group(this.actor);
        }
    );
     
     /*
      * Getter for the active workspace. Added for "polymorphistic" reasons.
      * @return: Workspace
      */
     ext.addMember(
         WorkspacesView.ExtraWorkspaceView,
         'getActiveWorkspace',
         function() {
             return this._workspace;
         }
     );
     
     /*
      * Getter for window overlays of the workspace.
      * @return: [ WindowOverlay ]
      */
     ext.addMember(
         WorkspacesView.ExtraWorkspaceView,
         'getWindowOverlays',
         function() {
             return this.getActiveWorkspace().getWindowOverlays();
         }
     );
     
    /*
     * Getter for window overlays of the active workspace and extra workspaces.
     * @return: [ WindowOverlay ]
     */
    ext.addMember(
        WorkspacesView.WorkspacesView,
        'getWindowOverlays',
        function() {
            return this.getActiveWorkspace().getWindowOverlays();
        }
    );
    
    /*
     * Injection into the function which is called at the end of the workspace-
     * switch. As there is no onComplete hook we have to wait a bit.
     */
    ext.injectAfter(
        WorkspacesView.WorkspacesView, 
        '_updateScrollAdjustment', 
        function() {
            ext.addTimeout(
                // Animation time is defined in seconds... 
                WorkspacesView.WORKSPACE_SWITCH_TIME * 1000 * 2,
                Lang.bind(this, function() {
                    this.emit('workspace-switched');
                })
            );
        }
    );
    
////////////////////////////////////////////////////////////////////////////////
// Workspace ///////////////////////////////////////////////////////////////////   
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Getter for window overlays of a workspace. 
     * @return: [ WindowOverlay ]
     */
    ext.addMember(
        Workspace.Workspace,
        'getWindowOverlays',
        function() {
            return this._windowOverlays.slice();
        }
    );
    
    /*
     * Emits a signal when the workspace starts the animation of the window-
     * repositioning.
     */
    ext.injectAfter(
        Workspace.Workspace, 
        '_updateWindowPositions', 
        function() {
            this.emit('window-positioning-start');
        }
    );
    
    /*
     * Emits a signal when the workspace prepares the animation of the window-
     * repositioning.
     */
    ext.injectBefore(
        Workspace.Workspace, 
        '_delayedWindowRepositioning', 
        function() {
            this.emit('window-positioning-init');
        }
    );
    
    /*
     * Emits a signal when the window-overlay of a window is shown and therefore
     * indicates the end of its animation.
     */
    ext.injectAfter(
        Workspace.Workspace, 
        '_showWindowOverlay', 
        function() {
            this.emit('window-ready');
        }
    );
    
////////////////////////////////////////////////////////////////////////////////
// WindowClone /////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Introduces a dictionary for window geometry and sets _origParent to null.
     */
    ext.injectAfter(
        Workspace.WindowClone, 
        '_init', 
        function(realWindow) {
            this.storedGeometry = {};
            this._origParent = null;
            this._origSibling = null;
        }
    );
    
    /*
     * Highlights and zooms the currently selected window.
     * @param lightbox: A reference to the lightbox introduced by 
     * _initSelection.
     */
    ext.addMember(
        Workspace.WindowClone,
        'select',
        function(lightbox) {
            let actor = this.actor;
            // Store the initial geometry of the window (might has changed
            // a little bit in the meantime).
            this.createGeometrySnapshot();
            // Store the original parent and highlight the window.
            this._origParent = actor.get_parent();
            this._origSibling = actor.get_previous_sibling();
            actor.raise_top();
            actor.reparent(Main.layoutManager.overviewGroup);
            lightbox.highlight(actor);
            // Define the available area.
            let monitorIndex = this.metaWindow.get_monitor();
            let availArea = Main.layoutManager.monitors[monitorIndex];
            let padding = cfg.PADDING;
            let limitTop = availArea.y + padding;
            let limitBottom = availArea.y + availArea.height - padding;
            let limitLeft = availArea.x + padding;
            let limitRight = availArea.x + availArea.width - padding;
            let limitWidth = limitRight - limitLeft;
            let limitHeight = limitBottom - limitTop;
            // Calculate the desired new dimension.
            let factor = cfg.ZOOM_FACTOR;
            let newScaleX = actor.scale_x * factor;
            let newScaleY = actor.scale_y * factor;
            let newWidth = actor.width * newScaleX;
            let newHeight = actor.height * newScaleY;
            // Adjust the dimension to the available area.
            while (newWidth > limitWidth || newHeight > limitHeight || 
                   newScaleX > 1.0 || newScaleY > 1.0) {
                factor -= 0.1;
                newScaleX = actor.scale_x * factor;
                newScaleY = actor.scale_y * factor;
                newWidth = actor.width * newScaleX;
                newHeight = actor.height * newScaleY;
            }
            // Calculate the desired new position.
            let deltaWidth =  newWidth - actor.width * actor.scale_x;
            let deltaHeight = newHeight - actor.height * actor.scale_y;
            let newX = actor.x - deltaWidth / 2;
            let newY = actor.y - deltaHeight / 2;
            // Adjust the new position to the available area.
            if (monitorIndex == Main.layoutManager.primaryIndex){
                limitTop += Main.panel.actor.height;
            }
            if (newX + newWidth > limitRight) newX = limitRight - newWidth;
            if (newX < limitLeft) newX = limitLeft;
            if (newY + newHeight > limitBottom) newY = limitBottom - newHeight;
            if (newY < limitTop) newY = limitTop;
            // Zoom the window.
            Tweener.addTween(actor, { 
                x: newX,
                y: newY,
                scale_x: newScaleX,
                scale_y: newScaleY,
                time: cfg.ZOOM_TIME,
                transition: 'easeOutQuad' 
             });
        }
    );
        
    /*
     * Reverts the adjustments done by WindowClone.select.
     * @param resetG: Flag which indicates if the geometry 
     * should be reset.
     */
    ext.addMember(
        Workspace.WindowClone,
        'unselect',
        function(resetG) {
            let actor = this.actor;
            if (resetG) {
                actor.x = this.storedGeometry.x; 
                actor.y = this.storedGeometry.y;
                actor.scale_x = this.storedGeometry.scale_x;
                actor.scale_y = this.storedGeometry.scale_y; 
                Tweener.removeTweens(actor);
            }
            if (this._origParent) {
                actor.reparent(this._origParent);
                if (this._origSibling) {
                    actor.raise(this._origSibling);
                } else {
                    actor.lower_bottom();
                }
            }
        }
    );
    
    /*
     * Creates a snapshot of the current window geometry.
     */
    ext.addMember(
        Workspace.WindowClone,
        'createGeometrySnapshot',
        function() {
            let actor = this.actor;
            let width = actor.width * actor.scale_x;
            let height = actor.height * actor.scale_y;
            this.storedGeometry = {
                x: actor.x, 
                y: actor.y,
                width: width,
                height: height, 
                scale_x: actor.scale_x,
                scale_y: actor.scale_y,
                center_x: actor.x + width / 2,
                center_y: actor.y + height / 2
            };
        }
    );
    
    /*
     * Overwrites the activation of the focused window.
     */
    ext.addMember(
        Workspace.WindowClone,
        '_onKeyPress',
        function(actor, event) {
            return false;
        }
    );
    
////////////////////////////////////////////////////////////////////////////////
// WindowOverlay ///////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Adds a border - actually two - for indicating the active window.
     */
    ext.injectAfter(
        Workspace.WindowOverlay, 
        '_init', 
        function(windowClone, parentActor) {
            this.activeBorderInner = new St.Bin(
                { style_class: 'active-window-clone-border-inner' }
            );
            this.activeBorderInner.hide();
            parentActor.add_actor(this.activeBorderInner);
            this.activeBorderInner.lower_bottom();
            this.activeBorderOuter = new St.Bin(
                { style_class: 'active-window-clone-border-outer' }
            );
            this.activeBorderOuter.hide();
            parentActor.add_actor(this.activeBorderOuter);
            this.activeBorderOuter.raise(this.activeBorderInner);
            this.isFocusWindow = false;
        }
    );
    
    /*
     * Destroys the previously added border (_init).
     */
    ext.injectAfter(
        Workspace.WindowOverlay, 
        '_onDestroy', 
        function() {
            this.activeBorderInner.destroy();
            this.activeBorderOuter.destroy();
        }
    );
    
    /*
     * Includes the border when the overlay is shown.
     */
    ext.injectAfter(
        Workspace.WindowOverlay, 
        'show', 
        function() {
            if (this.isFocusWindow) {
                this.activeBorderInner.show();
                this.activeBorderOuter.show(); 
            }
        }
    );
    
    /*
     * Includes the border when the overlay is hided.
     */
    ext.injectAfter(
        Workspace.WindowOverlay, 
        'hide', 
        function() {
            this.activeBorderInner.hide();
            this.activeBorderOuter.hide(); 
        }
    );
    
    /*
     * Subroutine of relayout which is called once with the window clone as
     * reference and another time with the return values of the first call.
     * @param referenceWin: Reference values from the window that is to 
     * be framed.
     * @param activeBorder: Reference to an St.Bin that will act as border.
     * @param animate: Flag which tells if the relayout should be animated.
     */
    ext.addMember(
        Workspace.WindowOverlay, 
        'relayoutSub', 
        function(referenceWin, activeBorder, animate) {
            let [cloneX, cloneY, cloneWidth, cloneHeight] = referenceWin;
            let borderNode = activeBorder.get_theme_node();
            let activeBorderSize = borderNode.get_border_width(St.Side.TOP);
            let borderX = cloneX - activeBorderSize;
            let borderY = cloneY - activeBorderSize;
            let borderWidth = cloneWidth + 2 * activeBorderSize;
            let borderHeight = cloneHeight + 2 * activeBorderSize;
            Tweener.removeTweens(activeBorder);
            if (animate) {
                this._animateOverlayActor(
                    activeBorder, 
                    borderX, 
                    borderY,
                    borderWidth, 
                    borderHeight
                );
            } else {
                activeBorder.set_position(borderX, borderY);
                activeBorder.set_size(borderWidth, borderHeight);
            }
            return [borderX, borderY, borderWidth, borderHeight];
        }
     );
    
    /*
     * Applies the border-style dependent on the size and position of the
     * window-clone it contains.
     * @param animate: Flag which tells if the relayout should be animated.
     */
    ext.injectAfter(
        Workspace.WindowOverlay, 
        'relayout', 
        function(animate) {
            this.relayoutSub(
                this.relayoutSub(
                    this._windowClone.slot, 
                    this.activeBorderInner,
                    animate
                ),
                this.activeBorderOuter,
                animate
            );
        }
    );
    
    /*
     * Selects the associated window. See WindowClone.select.
     * @param lightbox: A reference to the lightbox introduced by 
     * KeyCtrl's _initSelection.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'select',
        function(lightbox) {
            this.hide();
            this.setFocus(false);
            this._windowClone.select(lightbox);
        }
    );
    
    /*
     * Unselects the associated window. See WindowClone.unselect.
     * @param resetG: Flag which indicates if the geometry should be reset.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'unselect',
        function(resetG) {
        	if (resetG) {
        		this.show();
        	}
            this.setFocus(false);
            this._windowClone.unselect(resetG);
        }
    );
    
    /*
     * Marks the last window with a border or removes that border again.
     * @param set: Flag to indicate whether the window should be marked as 
     * focused/active or not.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'setFocus',
        function(set) {
            if (set) {
                this.activeBorderInner.show();
                this.activeBorderOuter.show();
            } else {
                this.activeBorderInner.hide();
                this.activeBorderOuter.hide();
            }
            this.isFocusWindow = set;
        }
    );
    
    /*
     * Closes the associated window.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'closeWindow',
        function() {
            this._closeWindow();
        }
    );
    
    /*
     * Returns a geometry-info object of the window clone.
     * @return: Object.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'getStoredGeometry',
        function() {
            return this._windowClone.storedGeometry;
        }
    );
    
    /*
     * Getter for the window clone.
     * @return: WindowClone.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'getWindowClone',
        function() {
            return this._windowClone;
        }
    );
    
    /*
     * Getter for the meta window.
     * @return: MetaWindow.
     */
    ext.addMember(
        Workspace.WindowOverlay,
        'getMetaWindow',
        function() {
            return this._windowClone.metaWindow;
        }
    );
}
    
    
function disable() {
    ext.cleanUp();
}
