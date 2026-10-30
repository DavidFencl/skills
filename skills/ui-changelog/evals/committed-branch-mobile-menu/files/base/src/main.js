// @ts-check
import { renderFooter } from './components/footer.js';
import { renderHeader } from './components/header.js';
import { renderHomePage } from './pages/home.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
app.append(renderHeader(), renderHomePage(), renderFooter());
