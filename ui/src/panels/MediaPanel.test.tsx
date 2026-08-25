import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MediaPanel } from './MediaPanel.js';
import { useProject } from '../stores/project.js';
import { demoProject } from '../test/fixtures.js';

describe('MediaPanel', () => {
  it('三個子區可切換；預設專案媒體', () => {
    useProject.setState({ doc: demoProject() });
    render(<MediaPanel />);
    expect(screen.getByTitle('Project media')).toBeTruthy();
    expect(screen.getByTitle('Library')).toBeTruthy();
    expect(screen.getByTitle('Source folder')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Library'));
    expect(screen.getByPlaceholderText('Search library')).toBeTruthy();
  });
});
