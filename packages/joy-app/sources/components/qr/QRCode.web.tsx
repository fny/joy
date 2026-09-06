import React from 'react';
import { View } from 'react-native';
import { createQRMatrix } from './qrMatrix';
import { finderPath } from './finderPath';

// Check if point is in a locator pattern area
function isInLocatorPattern(x: number, y: number, matrixSize: number): boolean {
    // Top-left pattern
    if (x < 7 && y < 7) return true;
    // Top-right pattern  
    if (x >= matrixSize - 7 && y < 7) return true;
    // Bottom-left pattern
    if (x < 7 && y >= matrixSize - 7) return true;
    return false;
}

// Generate SVG path string for rectangle with selective rounded corners
function getRectPath(x: number, y: number, w: number, h: number,
    tlr: number, trr: number, brr: number, blr: number): string {
    return `M ${x} ${y + tlr}
            A ${tlr} ${tlr} 0 0 1 ${x + tlr} ${y}
            L ${x + w - trr} ${y}
            A ${trr} ${trr} 0 0 1 ${x + w} ${y + trr}
            L ${x + w} ${y + h - brr}
            A ${brr} ${brr} 0 0 1 ${x + w - brr} ${y + h}
            L ${x + blr} ${y + h}
            A ${blr} ${blr} 0 0 1 ${x} ${y + h - blr}
            Z`;
}

interface QRCodeProps {
    data: string;
    size?: number;
    errorCorrectionLevel?: 'low' | 'medium' | 'quartile' | 'high';
    foregroundColor?: string;
    backgroundColor?: string;
}

export const QRCode = React.memo((props: QRCodeProps) => {
    const {
        data,
        size = 200,
        errorCorrectionLevel = 'medium',
        foregroundColor = '#000000',
        backgroundColor = '#FFFFFF'
    } = props;

    // Generate QR matrix
    const qrMatrix = React.useMemo(() => {
        return createQRMatrix(data, errorCorrectionLevel);
    }, [data, errorCorrectionLevel]);

    // Calculate module size
    const moduleSize = size / (qrMatrix.size + 4/* space around */);

    // Generate modules with rounded corners
    const modules = React.useMemo(() => {
        const elements: React.ReactElement[] = [];

        for (let y = 0; y < qrMatrix.size; y++) {
            for (let x = 0; x < qrMatrix.size; x++) {
                // Skip locator pattern areas
                if (isInLocatorPattern(x, y, qrMatrix.size)) continue;

                const neighbors = qrMatrix.getNeighbors(x, y);

                if (neighbors.current) {
                    let tlr = 0, trr = 0, brr = 0, blr = 0;
                    const cornerRadius = Math.min(moduleSize / 3, size * 0.01);

                    // Calculate rounded corners (using corrected logic from mobile)
                    if (!neighbors.top && !neighbors.left) tlr = cornerRadius;    // top-left
                    if (!neighbors.top && !neighbors.right) blr = cornerRadius;   // bottom-left
                    if (!neighbors.bottom && !neighbors.left) trr = cornerRadius; // top-right
                    if (!neighbors.bottom && !neighbors.right) brr = cornerRadius; // bottom-right

                    // Use path if any corner is rounded
                    if (tlr || trr || brr || blr) {
                        const pathData = getRectPath(
                            x * moduleSize - 0.5 + 2 * moduleSize,
                            y * moduleSize - 0.5 + 2 * moduleSize,
                            moduleSize + 1,
                            moduleSize + 1,
                            tlr, trr, brr, blr
                        );

                        elements.push(
                            <path
                                key={`${x}-${y}`}
                                d={pathData}
                                fill={foregroundColor}
                            />
                        );
                    } else {
                        // Use simple rect for modules with no rounded corners
                        elements.push(
                            <rect
                                key={`${x}-${y}`}
                                x={x * moduleSize - 0.5 + 2 * moduleSize}
                                y={y * moduleSize - 0.5 + 2 * moduleSize}
                                width={moduleSize + 1}
                                height={moduleSize + 1}
                                fill={foregroundColor}
                            />
                        );
                    }
                }
            }
        }

        return elements;
    }, [qrMatrix, moduleSize, foregroundColor]);

    return (
        <View
            style={{
                width: size,
                height: size,
            }}
        >
            <svg
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                style={{ display: 'block', borderRadius: moduleSize }}
            >
                {/* Background */}
                <rect
                    x={0}
                    y={0}
                    width={size}
                    height={size}
                    fill={backgroundColor}
                />

                {/* QR modules with rounded corners */}
                {modules}

                {/* Finder patterns: square rings, hole cut out with an even-odd
                    path so a transparent background stays transparent — the
                    old background-coloured hole rect turned solid over a
                    transparent page (#273), and rounded rings did not decode
                    in OpenCV (#272). */}
                <path d={finderPath(2 * moduleSize, 2 * moduleSize, moduleSize)} fill={foregroundColor} fillRule="evenodd" />
                <path d={finderPath((qrMatrix.size - 7 + 2) * moduleSize, 2 * moduleSize, moduleSize)} fill={foregroundColor} fillRule="evenodd" />
                <path d={finderPath(2 * moduleSize, (qrMatrix.size - 7 + 2) * moduleSize, moduleSize)} fill={foregroundColor} fillRule="evenodd" />
            </svg>
        </View>
    );
});