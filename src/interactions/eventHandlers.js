/**
 * Event handler for point click events.
 * @param {Object} event - The event object containing the click event.
 * @param {Object} dataBinding - The data binding object containing the data.
 * @param {Array} dimensions - Array of dimension objects.
 * @param {Object} widget - Reference to the widget ('this', in context).
 */
export function handlePointClick(event, dataBinding, dimensions, widget) {
    const point = event.target;
    console.log('Point clicked:', point);
    if (!point) {
        console.log('Point undefined');
        return;
    }

    const linkedAnalysis = widget.dataBindings.getDataBinding('dataBinding').getLinkedAnalysis();

    const dimension = dimensions[0];
    const label = point.category;

    

    const row = dataBinding.data.find(
        r => r[dimension.key]?.label === label
    );

    linkedAnalysis.removeFilters();

    if (widget._selectedPoint && widget._selectedPoint !== point) {
        widget._selectedPoint.select(false, false);
    }
    widget._selectedPoint = null;

    if (event.type === 'select') {
        if (row) {
            const selection = {};
            selection[dimension.id] = row[dimension.key].id;
            linkedAnalysis.setFilters(selection);
            widget._selectedPoint = point;
        }
    } else if (event.type === 'unselect') {
        linkedAnalysis.removeFilters();
        widget._selectedPoint = null;
    }
}