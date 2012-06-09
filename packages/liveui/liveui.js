Meteor.ui = Meteor.ui || {};

(function() {

  var walkRanges = function(frag, originalHtml, idToChunk) {
    // Helper that invokes `f` on every comment node under `parent`.
    // If `f` returns a node, visit that node next.
    var each_comment = function(parent, f) {
      for (var n = parent.firstChild; n;) {
        if (n.nodeType === 8) { // comment
          n = f(n) || n.nextSibling;
          continue;
        } else if (n.nodeType === 1) { // element
          each_comment(n, f);
        }
        n = n.nextSibling;
      }
    };

    // walk comments and create ranges
    var rangeStartNodes = {};
    var chunksToWire = [];
    each_comment(frag, function(n) {

      var rangeCommentMatch = /^\s*(START|END)RANGE_(\S+)/.exec(n.nodeValue);
      if (! rangeCommentMatch)
        return null;

      var which = rangeCommentMatch[1];
      var id = rangeCommentMatch[2];

      if (which === "START") {
        if (rangeStartNodes[id])
          throw new Error("The return value of chunk can only be used once.");
        rangeStartNodes[id] = n;

        return null;
      }
      // else: which === "END"

      var startNode = rangeStartNodes[id];
      var endNode = n;
      var next = endNode.nextSibling;

      // try to remove comments
      var a = startNode, b = endNode;
      if (a.nextSibling && b.previousSibling) {
        if (a.nextSibling === b) {
          // replace two adjacent comments with one
          endNode = startNode;
          b.parentNode.removeChild(b);
          startNode.nodeValue = 'placeholder';
        } else {
          // remove both comments
          startNode = startNode.nextSibling;
          endNode = endNode.previousSibling;
          a.parentNode.removeChild(a);
          b.parentNode.removeChild(b);
        }
      } else {
        /* shouldn't happen; invalid HTML? */
      }

      if (startNode.parentNode !== endNode.parentNode) {
        // Try to fix messed-up comment ranges like
        // <!-- #1 --><tbody> ... <!-- /#1 --></tbody>,
        // which are extremely common with tables.  Tests
        // fail in all browsers without this code.
        if (startNode === endNode.parentNode ||
            startNode === endNode.parentNode.previousSibling) {
          startNode = endNode.parentNode.firstChild;
        } else if (endNode === startNode.parentNode ||
                   endNode === startNode.parentNode.nextSibling) {
          endNode = startNode.parentNode.lastChild;
        } else {
          var html = originalHtml;
          var r = new RegExp('<!--\\s*STARTRANGE_'+id+'.*?-->', 'g');
          var match = r.exec(html);
          var help = "";
          if (match) {
            var comment_end = r.lastIndex;
            var comment_start = comment_end - match[0].length;
            var stripped_before = html.slice(0, comment_start).replace(
                /<!--\s*(START|END)RANGE.*?-->/g, '');
            var stripped_after = html.slice(comment_end).replace(
                /<!--\s*(START|END)RANGE.*?-->/g, '');
            var context_amount = 50;
            var context = stripped_before.slice(-context_amount) +
                  stripped_after.slice(0, context_amount);
            help = " (possible unclosed near: "+context+")";
          }
          throw new Error("Could not create liverange in template. "+
                          "Check for unclosed tags in your HTML."+help);
        }
      }

      var range = new Meteor.ui._LiveRange(Meteor.ui._tag, startNode, endNode);
      var chunk = idToChunk[id];
      if (chunk) {
        chunk.range = range;
        chunksToWire.push(chunk);
      }

      return next;
    });

    return chunksToWire;
  };

  var render = function(chunk) {
    var html_func = chunk.html_func;
    var react_data = chunk.react_data;

    var idToChunk = {};
    Meteor.ui._render_mode = {
      nextId: 1,
      idToChunk: idToChunk
    };

    var html;
    try {
      html = calculate(chunk);
    } finally {
      Meteor.ui._render_mode = null;
    }

    var frag = Meteor.ui._htmlToFragment(html);
    if (! frag.firstChild)
      frag.appendChild(document.createComment("empty"));


    var chunksToWire = walkRanges(frag, html, idToChunk);

    var range = chunk.range;
    if (range) {
      // update chunk in place.
      Meteor.ui._intelligent_replace(range, frag);
      frag = null;
    } else {
      chunk.range = new Meteor.ui._LiveRange(Meteor.ui._tag, frag);
    }

    // wire up chunk and all sub-chunks
    wireChunk(chunk);
    _.each(chunksToWire, function(c) {
      wireChunk(c);
    });

    // fire notification on chunk and all sub-chunks,
    // now that chunk hierarchy is established.
    chunk.onlive();
    _.each(chunksToWire, function(c) {
      c.onlive();
    });

    return frag;
  };

  var calculate = function(chunk) {
    var html = chunk.context.run(chunk.html_func);
    if (typeof html !== "string")
      throw new Error("Render function must return a string");
    return html;
  };

  // In render mode (i.e. inside Meteor.ui.render), this is an
  // object, otherwise it is null.
  // callbacks: id -> func, where id ranges from 1 to callbacks._count.
  Meteor.ui._render_mode = null;

  Meteor.ui.render = function (html_func, react_data, xxx_in_range) {
    if (typeof html_func !== "function")
      throw new Error("Meteor.ui.render() requires a function as its first argument.");

    if (Meteor.ui._render_mode)
      throw new Error("Can't nest Meteor.ui.render.");

    var c = new Chunk(html_func, react_data);
    if (xxx_in_range) {
      c.range = xxx_in_range;
      render(c);
      return null;
    }

    return render(c);
  };

  Meteor.ui.chunk = function(html_func, react_data) {
    if (typeof html_func !== "function")
      throw new Error("Meteor.ui.chunk() requires a function as its first argument.");

    if (! Meteor.ui._render_mode)
      return html_func();

    var c = new Chunk(html_func, react_data);
    var html = calculate(c);

    return Meteor.ui._ranged_html(html, c);
  };

  Meteor.ui.listChunk = function (observable, doc_func, else_func, react_data) {
    if (arguments.length === 3 && typeof else_func === "object") {
      // support (observable, doc_func, react_data) form
      react_data = else_func;
      else_func = null;
    }

    if (typeof doc_func !== "function")
      throw new Error("Meteor.ui.listChunk() requires a function as first argument");
    else_func = (typeof else_func === "function" ? else_func :
                 function() { return ""; });
    react_data = react_data || {};

    var buf = [];
    var receiver = new Meteor.ui._CallbackReceiver();

    var handle = observable.observe(receiver);
    receiver.flush_to_array(buf);

    var inner_html;
    if (buf.length === 0) {
      inner_html = Meteor.ui.chunk(else_func, react_data);
    } else {
      var doc_render = function(doc) {
        return Meteor.ui._ranged_html(
          Meteor.ui.chunk(function() { return doc_func(doc); },
                          _.extend({}, react_data, {event_data: doc})));
      };
      inner_html = _.map(buf, doc_render).join('');
    }

    if (! Meteor.ui._render_mode) {
      handle.stop();
      return inner_html;
    }

    /*var c = new Chunk(null, null);
    c.onlive = function() {
      this.chunkList = this.childChunks();
    };

    c.onsignal = function() {

    };*/

    return Meteor.ui._ranged_html(inner_html, function(outer_range) {
      var range_list = [];
      // find immediate sub-ranges of range, and add to range_list
      if (buf.length > 0) {
        outer_range.visit(function(is_start, r) {
          if (is_start)
            range_list.push(r);
          return false;
        });
      }

      Meteor.ui._wire_up_list(outer_range, range_list, receiver, handle,
                              doc_func, else_func, react_data);
    });
  };


  var killContext = function(range) {
    if (range.chunk) {
      range.chunk.kill();
    }
    // XXXXX
    var cx = range.context;
    if (cx && ! cx.killed) {
      cx.killed = true;
      cx.invalidate && cx.invalidate();
      delete range.context;
    }
  };

  Meteor.ui._tag = "_liveui";

  var _checkOffscreen = function(range) {
    var node = range.firstNode();

    if (node.parentNode &&
        (Meteor.ui._onscreen(node) || Meteor.ui._is_held(node)))
      return false;

    cleanup_range(range);

    return true;
  };

  // Internal facility, only used by tests, for holding onto
  // DocumentFragments across flush().  Reference counts
  // using hold() and release().
  Meteor.ui._is_held = function(node) {
    while (node.parentNode)
      node = node.parentNode;

    return node.nodeType !== 3 /*TEXT_NODE*/ && node._liveui_refs;
  };
  Meteor.ui._hold = function(frag) {
    frag._liveui_refs = (frag._liveui_refs || 0) + 1;
  };
  Meteor.ui._release = function(frag) {
    // Clean up on flush, if hits 0.
    // Don't want to decrement
    // _liveui_refs to 0 now because someone else might
    // clean it up if it's not held.
    var cx = new Meteor.deps.Context;
    cx.on_invalidate(function() {
      --frag._liveui_refs;
      if (! frag._liveui_refs)
        cleanup_frag(frag);
    });
    cx.invalidate();
  };

  Meteor.ui._onscreen = function (node) {
    // http://jsperf.com/is-element-in-the-dom

    if (document.compareDocumentPosition)
      return document.compareDocumentPosition(node) & 16;
    else {
      if (node.nodeType !== 1 /* Element */)
        /* contains() doesn't work reliably on non-Elements. Fine on
         Chrome, not so much on Safari and IE. */
        node = node.parentNode;
      if (node.nodeType === 11 /* DocumentFragment */ ||
          node.nodeType === 9 /* Document */)
        /* contains() chokes on DocumentFragments on IE8 */
        return node === document;
      /* contains() exists on document on Chrome, but only on
       document.body on some other browsers. */
      return document.body.contains(node);
    }
  };

  var CallbackReceiver = function() {
    var self = this;

    self.queue = [];
    self.deps = {};

    // attach these callback funcs to each instance, as they may
    // not be called as methods by livedata.
    _.each(["added", "removed", "moved", "changed"], function (name) {
      self[name] = function (/* arguments */) {
        self.queue.push([name].concat(_.toArray(arguments)));
        self.signal();
      };
    });
  };

  Meteor.ui._CallbackReceiver = CallbackReceiver;

  CallbackReceiver.prototype.flush_to = function(t) {
    // fire all queued events on new target
    _.each(this.queue, function(x) {
      var name = x[0];
      var args = x.slice(1);
      t[name].apply(t, args);
    });
    this.queue.length = 0;
  };
  CallbackReceiver.prototype.flush_to_array = function(array) {
    // apply all queued events to array
    _.each(this.queue, function(x) {
      switch (x[0]) {
      case 'added': array.splice(x[2], 0, x[1]); break;
      case 'removed': array.splice(x[2], 1); break;
      case 'moved': array.splice(x[3], 0, array.splice(x[2], 1)[0]); break;
      case 'changed': array[x[2]] = x[1]; break;
      }
    });
    this.queue.length = 0;
  };
  CallbackReceiver.prototype.signal = function() {
    if (this.queue.length > 0) {
      for(var id in this.deps)
        this.deps[id].invalidate();
    }
  };
  CallbackReceiver.prototype.depend = function() {
    var context = Meteor.deps.Context.current;
    if (context && !(context.id in this.deps)) {
      this.deps[context.id] = context;
      var self = this;
      context.on_invalidate(function() {
        delete self.deps[context.id];
      });
    }
  };

  // Performs a replacement by determining which nodes should
  // be preserved and invoking Meteor.ui._Patcher as appropriate.
  Meteor.ui._intelligent_replace = function(tgtRange, srcParent) {

    // Table-body fix:  if tgtRange is in a table and srcParent
    // contains a TR, wrap fragment in a TBODY on all browsers,
    // so that it will display properly in IE.
    if (tgtRange.containerNode().nodeName === "TABLE" &&
        _.any(srcParent.childNodes,
              function(n) { return n.nodeName === "TR"; })) {
      var tbody = document.createElement("TBODY");
      while (srcParent.firstChild)
        tbody.appendChild(srcParent.firstChild);
      srcParent.appendChild(tbody);
    }

    var copyFunc = function(t, s) {
      Meteor.ui._LiveRange.transplant_tag(Meteor.ui._tag, t, s);
    };

    //tgtRange.replace_contents(srcParent);

    tgtRange.operate(function(start, end) {
      // clear all LiveRanges on target
      cleanup_range(new Meteor.ui._LiveRange(Meteor.ui._tag, start, end));

      var patcher = new Meteor.ui._Patcher(
        start.parentNode, srcParent,
        start.previousSibling, end.nextSibling);
      patcher.diffpatch(copyFunc);
    });

    attach_secondary_events(tgtRange);
  };

  var wireChunk = function(chunk) {
    // chunk.range has been set.
    var range = chunk.range;
    if (range.chunk !== chunk) // XXXXXXXXXXXXXXXXXXX
      killContext(range);
    range.chunk = chunk;
    chunk.onlive();
  };

  var Chunk = function(html_func, react_data) {
    var self = this;
    self.html_func = html_func;
    self.react_data = react_data;

    // Meteor.deps integration.
    // When self.context is invalidated, recreate it
    // and call self.onsignal().
    var signaled = function() {
      if ((! self.killed) &&
          ((! self.range) || _checkOffscreen(self.range)))
        self.killed = true;
      if (self.killed) {
        self.context.invalidate();
        self.context = null;
        self.onkill();
      } else {
        self.context = new Meteor.deps.Context;
        self.context.on_invalidate(signaled);
        self.onsignal();
      }
    };
    self.context = new Meteor.deps.Context;
    self.context.on_invalidate(signaled);
  };

  Chunk.prototype.kill = function() {
    if (! this.killed) {
      this.killed = true;
      this.signal();
    }
  };

  Chunk.prototype.signal = function() {
    this.context.invalidate();
  };

  Chunk.prototype.onsignal = function() {
    render(this);
  };

  Chunk.prototype.onkill = function() {};

  // called when we get a range, or contents are replaced
  Chunk.prototype.onlive = function() {
    var self = this;

    var range = self.range;

    // wire events
    var data = self.react_data || {};
    if (data.events)
      range.event_handlers = unpackEventMap(data.events);
    if (data.event_data)
      range.event_data = data.event_data;

    attach_events(range);
  };

  Chunk.prototype.childChunks = function() {
    if (! this.range)
      throw new Error("Chunk not rendered yet");

    var chunks = [];
    this.range.visit(function(is_start, r) {
      if (! is_start)
        return false;
      if (! r.chunk)
        return true; // allow for intervening LiveRanges
      chunks.push(r.chunk);
      return false;
    });

    return chunks;
  };

  // Convert an event map from the developer into an internal
  // format for range.event_handlers.  The internal format is
  // an array of objects with properties {type, selector, callback}.
  // The array has an expando property `types`, which is a list
  // of all the unique event types used (as an optimization for
  // code that needs this info).
  var unpackEventMap = function(events) {
    var handlers = [];

    var eventTypeSet = {};

    // iterate over `spec: callback` map
    _.each(events, function(callback, spec) {
      var clauses = spec.split(/,\s+/);
      // iterate over clauses of spec, e.g. ['click .foo', 'click .bar']
      _.each(clauses, function (clause) {
        var parts = clause.split(/\s+/);
        if (parts.length === 0)
          return;

        var type = parts.shift();
        var selector = parts.join(' ');

        handlers.push({type:type, selector:selector, callback:callback});
        eventTypeSet[type] = true;
      });
    });

    handlers.types = _.keys(eventTypeSet);
    return handlers;
  };

  Meteor.ui._wire_up_list =
    function(outer_range, range_list, receiver, handle_to_stop,
             doc_func, else_func, react_data)
  {
    react_data = react_data || {};

    outer_range.context = new Meteor.deps.Context;
    outer_range.context.run(function() {
      receiver.depend();
    });
    outer_range.context.on_invalidate(function update(old_cx) {
      if (old_cx.killed || _checkOffscreen(outer_range)) {
        if (handle_to_stop)
          handle_to_stop.stop();
        return;
      }

      receiver.flush_to(callbacks);

      Meteor.ui._wire_up_list(outer_range, range_list, receiver,
                              handle_to_stop, doc_func, else_func,
                              react_data);
    });

    var renderItem = function(doc, in_range) {
      return Meteor.ui.render(
          _.bind(doc_func, null, doc),
        _.extend({}, react_data, {event_data: doc}),
        in_range);
    };

    var renderElse = function() {
      return Meteor.ui.render(else_func, react_data);
    };

    var callbacks = {
      added: function(doc, before_idx) {
        var frag = renderItem(doc);
        var range = new Meteor.ui._LiveRange(Meteor.ui._tag, frag);
        if (range_list.length === 0)
          cleanup_frag(outer_range.replace_contents(frag));
        else if (before_idx === range_list.length)
          range_list[range_list.length-1].insert_after(frag);
        else
          range_list[before_idx].insert_before(frag);

        attach_secondary_events(range);

        range_list.splice(before_idx, 0, range);
      },
      removed: function(doc, at_idx) {
        if (range_list.length === 1) {
          cleanup_frag(
            outer_range.replace_contents(renderElse()));
          attach_secondary_events(outer_range);
        } else {
          cleanup_frag(range_list[at_idx].extract());
        }

        range_list.splice(at_idx, 1);
      },
      moved: function(doc, old_idx, new_idx) {
        if (old_idx === new_idx)
          return;

        var range = range_list[old_idx];
        // We know the list has at least two items,
        // at old_idx and new_idx, so `extract` will succeed.
        var frag = range.extract(true);
        range_list.splice(old_idx, 1);

        if (new_idx === range_list.length)
          range_list[range_list.length-1].insert_after(frag);
        else
          range_list[new_idx].insert_before(frag);
        range_list.splice(new_idx, 0, range);
      },
      changed: function(doc, at_idx) {
        var range = range_list[at_idx];

        // replace the render in the immediately nested range
        range.visit(function(is_start, r) {
          if (is_start)
            renderItem(doc, r);
          return false;
        });
      }
    };
  };

  Meteor.ui._ranged_html = function(html, chunk) {
    if (! Meteor.ui._render_mode)
      return html;

    var idToChunk = Meteor.ui._render_mode.idToChunk;
    var commentId = Meteor.ui._render_mode.nextId ++;

    if (chunk) {
      if (typeof chunk === "function") { // XXX
        var callback = chunk;
        chunk = {
          onlive: function() {
            callback(this.range);
          },
          kill: function() {}
        };
      }
      idToChunk[commentId] = chunk;
    }

    return "<!-- STARTRANGE_"+commentId+" -->" + html +
      "<!-- ENDRANGE_"+commentId+" -->";
  };

  var cleanup_frag = function(frag) {
    // wrap the frag in a new LiveRange that will be destroyed
    cleanup_range(new Meteor.ui._LiveRange(Meteor.ui._tag, frag));
  };

  // Cleans up a range and its descendant ranges by calling
  // killContext on them (which removes any associated context
  // from dependency tracking) and then destroy (which removes
  // the liverange data from the DOM).
  var cleanup_range = function(range) {
    range.visit(function(is_start, range) {
      if (is_start)
        killContext(range);
    });
    range.destroy(true);
  };

  // Attach events specified by `range` to top-level nodes in `range`.
  // The nodes may still be in a DocumentFragment.
  var attach_events = function(range) {
    if (! range.event_handlers)
      return;

    _.each(range.event_handlers.types, function(t) {
      for(var n = range.firstNode(), after = range.lastNode().nextSibling;
          n && n !== after;
          n = n.nextSibling)
        Meteor.ui._event.registerEventType(t, n);
    });
  };

  // Attach events specified by enclosing ranges of `range`, at the
  // same DOM level, to nodes in `range`.  This is necessary if
  // `range` has just been inserted (as in the case of list 'added'
  // events) or if it has been re-rendered but its enclosing ranges
  // haven't.  In either case, the nodes in `range` have been rendered
  // without taking enclosing ranges into account, so additional event
  // handlers need to be attached.
  var attach_secondary_events = function(range) {
    // Implementations of LiveEvents that use whole-document event capture
    // (all except old IE) don't actually need any of this; this function
    // could be a no-op.
    for(var r = range; r; r = r.findParent()) {
      if (r === range)
        continue;
      if (! r.event_handlers)
        continue;

      var eventTypes = r.event_handlers.types;
      _.each(eventTypes, function(t) {
        for(var n = range.firstNode(), after = range.lastNode().nextSibling;
            n && n !== after;
            n = n.nextSibling)
          Meteor.ui._event.registerEventType(t, n);
      });
    }
  };

  // Handle a currently-propagating event on a particular node.
  // We walk all enclosing liveranges of the node, from the inside out,
  // looking for matching handlers.  If the app calls stopPropagation(),
  // we still call all handlers in all event maps for the current node.
  // If the app calls "stopImmediatePropagation()", we don't call any
  // more handlers.
  Meteor.ui._handleEvent = function(event) {
    var curNode = event.currentTarget;
    if (! curNode)
      return;

    var innerRange = Meteor.ui._LiveRange.findRange(Meteor.ui._tag, curNode);
    if (! innerRange)
      return;

    var type = event.type;

    for(var range = innerRange; range; range = range.findParent()) {
      var event_handlers = range.event_handlers;
      if (! event_handlers)
        continue;

      for(var i=0, N=event_handlers.length; i<N; i++) {
        var h = event_handlers[i];

        if (h.type !== type)
          continue;

        var selector = h.selector;
        if (selector) {
          var contextNode = range.containerNode();
          var results = $(contextNode).find(selector);
          if (! _.contains(results, curNode))
            continue;
        } else {
          // if no selector, only match the event target
          if (curNode !== event.target)
            continue;
        }

        var event_data = findEventData(event.target);
        var returnValue = h.callback.call(event_data, event);
        // allow app to `return false` from event handler, just like
        // you can in a jquery event handler
        if (returnValue === false) {
          event.stopImmediatePropagation();
          event.preventDefault();
        }
        if (event.isImmediatePropagationStopped())
          break; // stop handling by this and other event maps
      }
    }

  };

  // find the innermost enclosing liverange that has event_data
  var findEventData = function(node) {
    var innerRange = Meteor.ui._LiveRange.findRange(Meteor.ui._tag, node);

    for(var range = innerRange; range; range = range.findParent())
      if (range.event_data)
        return range.event_data;

    return null;
  };

  Meteor.ui._event.setHandler(Meteor.ui._handleEvent);
})();
