
/**
 * Returns a CSSStyleSheet instance for the Bubble Chart widget.
 * This is applied to the widget's shadow DOM.
 * @returns {CSSStyleSheet}
 */
export function createChartStylesheet() {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
        @font-face {
            font-family: '72';
            src: url('../fonts/72-Regular.woff2') format('woff2');
        }
        #container {
            display: flex;
            flex-direction: column;
            font-family: '72';
        }
        #parent-container {
            width: 100%;
            display: flex;
            flex-direction: column;
            height: 100%;
        }
    `);
    return sheet;
}