// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {PagoAtomicoMXNB} from "../../contracts/PagoAtomicoMXNB.sol";
import {MXNBMock} from "./mocks/MXNBMock.sol";

contract PagoAtomicoMXNBTest is Test {
    MXNBMock internal mxnb;
    PagoAtomicoMXNB internal pago;

    address internal owner = makeAddr("owner");
    address internal operador = makeAddr("operador");
    address internal tesoreria = makeAddr("tesoreria");
    address internal comprador = makeAddr("comprador");
    address internal creador = makeAddr("creador");
    address internal atacante = makeAddr("atacante");

    uint16 internal constant COMISION = 500; // 5 %
    uint128 internal constant MONTO = 1_000_000_000; // 1,000 MXNB
    uint64 internal constant VIGENCIA = 15 minutes;
    bytes16 internal constant ORDEN = bytes16(keccak256("orden-1"));

    function setUp() public {
        vm.warp(1_700_000_000);
        mxnb = new MXNBMock();
        pago = new PagoAtomicoMXNB(IERC20(address(mxnb)), tesoreria, operador, COMISION, owner);
        mxnb.mint(comprador, 10_000_000_000); // 10,000 MXNB
    }

    // ───────────── Ayudas ─────────────

    function _expira() internal view returns (uint64) {
        return uint64(block.timestamp) + VIGENCIA;
    }

    function _crear(bytes16 id, uint128 monto) internal {
        vm.prank(operador);
        pago.crearOrden(id, comprador, creador, monto, _expira());
    }

    function _pagar(bytes16 id, uint256 aprobado) internal {
        vm.startPrank(comprador);
        mxnb.approve(address(pago), aprobado);
        pago.pagarOrden(id);
        vm.stopPrank();
    }

    // ───────────── Constructor ─────────────

    function test_Constructor_GuardaParametros() public view {
        assertEq(address(pago.mxnb()), address(mxnb));
        assertEq(pago.tesoreria(), tesoreria);
        assertEq(pago.operador(), operador);
        assertEq(pago.comisionBps(), COMISION);
        assertEq(pago.owner(), owner);
    }

    function test_Constructor_RevierteConDireccionCero() public {
        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        new PagoAtomicoMXNB(IERC20(address(0)), tesoreria, operador, COMISION, owner);

        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        new PagoAtomicoMXNB(IERC20(address(mxnb)), address(0), operador, COMISION, owner);

        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        new PagoAtomicoMXNB(IERC20(address(mxnb)), tesoreria, address(0), COMISION, owner);
    }

    function test_Constructor_RevierteConComisionSobreElMaximo() public {
        uint16 maximo = pago.COMISION_MAXIMA_BPS();
        vm.expectRevert(PagoAtomicoMXNB.ComisionInvalida.selector);
        new PagoAtomicoMXNB(IERC20(address(mxnb)), tesoreria, operador, maximo + 1, owner);
    }

    // ───────────── crearOrden ─────────────

    function test_CrearOrden_GuardaYEmite() public {
        uint64 expira = _expira();
        vm.expectEmit(true, true, true, true, address(pago));
        emit PagoAtomicoMXNB.OrdenCreada(ORDEN, comprador, creador, MONTO, COMISION, expira);

        vm.prank(operador);
        pago.crearOrden(ORDEN, comprador, creador, MONTO, expira);

        (address c, address cr, uint128 m, uint16 bps, bool pagada, bool cancelada, uint64 exp) = pago.ordenes(ORDEN);
        assertEq(c, comprador);
        assertEq(cr, creador);
        assertEq(m, MONTO);
        assertEq(bps, COMISION);
        assertFalse(pagada);
        assertFalse(cancelada);
        assertEq(exp, expira);
    }

    function test_CrearOrden_SoloOperador() public {
        uint64 expira = _expira();
        vm.prank(atacante);
        vm.expectRevert(PagoAtomicoMXNB.NoAutorizado.selector);
        pago.crearOrden(ORDEN, comprador, creador, MONTO, expira);
    }

    function test_CrearOrden_RevierteConDireccionCero() public {
        uint64 expira = _expira();
        vm.startPrank(operador);
        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        pago.crearOrden(ORDEN, address(0), creador, MONTO, expira);
        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        pago.crearOrden(ORDEN, comprador, address(0), MONTO, expira);
        vm.stopPrank();
    }

    function test_CrearOrden_RevierteConMontoCero() public {
        uint64 expira = _expira();
        vm.prank(operador);
        vm.expectRevert(PagoAtomicoMXNB.MontoInvalido.selector);
        pago.crearOrden(ORDEN, comprador, creador, 0, expira);
    }

    function test_CrearOrden_RevierteConCaducidadPasadaOActual() public {
        uint64 ahora = uint64(block.timestamp);
        vm.startPrank(operador);
        vm.expectRevert(PagoAtomicoMXNB.CaducidadInvalida.selector);
        pago.crearOrden(ORDEN, comprador, creador, MONTO, ahora);
        vm.expectRevert(PagoAtomicoMXNB.CaducidadInvalida.selector);
        pago.crearOrden(ORDEN, comprador, creador, MONTO, ahora - 1);
        vm.stopPrank();
    }

    function test_CrearOrden_RevierteSiYaExiste() public {
        _crear(ORDEN, MONTO);
        uint64 expira = _expira();
        vm.prank(operador);
        vm.expectRevert(PagoAtomicoMXNB.OrdenExistente.selector);
        pago.crearOrden(ORDEN, comprador, creador, MONTO, expira);
    }

    function test_CrearOrden_RevierteEnPausa() public {
        vm.prank(owner);
        pago.pausar();
        uint64 expira = _expira();
        vm.prank(operador);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pago.crearOrden(ORDEN, comprador, creador, MONTO, expira);
    }

    // ───────────── pagarOrden ─────────────

    function test_PagarOrden_RepartePagoYEmite() public {
        _crear(ORDEN, MONTO);
        uint256 plataforma = (uint256(MONTO) * COMISION) / 10_000; // 50 MXNB
        uint256 parteCreador = MONTO - plataforma; // 950 MXNB
        uint256 saldoInicial = mxnb.balanceOf(comprador);

        vm.prank(comprador);
        mxnb.approve(address(pago), MONTO);

        vm.expectEmit(true, true, true, true, address(pago));
        emit PagoAtomicoMXNB.CompraConfirmada(ORDEN, comprador, creador, MONTO, parteCreador, plataforma);
        vm.prank(comprador);
        pago.pagarOrden(ORDEN);

        assertEq(mxnb.balanceOf(creador), parteCreador);
        assertEq(mxnb.balanceOf(tesoreria), plataforma);
        assertEq(mxnb.balanceOf(comprador), saldoInicial - MONTO);
        assertEq(mxnb.balanceOf(address(pago)), 0);
        assertEq(mxnb.allowance(comprador, address(pago)), 0);

        (,,,, bool pagada,,) = pago.ordenes(ORDEN);
        assertTrue(pagada);
    }

    function test_PagarOrden_SinComisionTodoAlCreador() public {
        vm.prank(owner);
        pago.setComisionBps(0);
        _crear(ORDEN, MONTO);
        _pagar(ORDEN, MONTO);
        assertEq(mxnb.balanceOf(creador), MONTO);
        assertEq(mxnb.balanceOf(tesoreria), 0);
    }

    function test_PagarOrden_UsaLaComisionCongelada() public {
        _crear(ORDEN, MONTO);
        vm.prank(owner);
        pago.setComisionBps(2_000);
        _pagar(ORDEN, MONTO);
        assertEq(mxnb.balanceOf(tesoreria), (uint256(MONTO) * COMISION) / 10_000);
    }

    function test_PagarOrden_RevierteSiNoExiste() public {
        vm.prank(comprador);
        vm.expectRevert(PagoAtomicoMXNB.OrdenInexistente.selector);
        pago.pagarOrden(ORDEN);
    }

    function test_PagarOrden_SoloElComprador() public {
        _crear(ORDEN, MONTO);
        mxnb.mint(atacante, MONTO);
        vm.startPrank(atacante);
        mxnb.approve(address(pago), MONTO);
        vm.expectRevert(PagoAtomicoMXNB.CompradorInvalido.selector);
        pago.pagarOrden(ORDEN);
        vm.stopPrank();
    }

    function test_PagarOrden_NoSePuedePagarDosVeces() public {
        _crear(ORDEN, MONTO);
        _pagar(ORDEN, MONTO);
        vm.startPrank(comprador);
        mxnb.approve(address(pago), MONTO);
        vm.expectRevert(PagoAtomicoMXNB.OrdenNoPagable.selector);
        pago.pagarOrden(ORDEN);
        vm.stopPrank();
    }

    function test_PagarOrden_RevierteSiEstaCancelada() public {
        _crear(ORDEN, MONTO);
        vm.prank(operador);
        pago.cancelarOrden(ORDEN);
        vm.startPrank(comprador);
        mxnb.approve(address(pago), MONTO);
        vm.expectRevert(PagoAtomicoMXNB.OrdenNoPagable.selector);
        pago.pagarOrden(ORDEN);
        vm.stopPrank();
    }

    function test_PagarOrden_FuncionaJustoAntesDeCaducar() public {
        _crear(ORDEN, MONTO);
        vm.warp(block.timestamp + VIGENCIA - 1);
        _pagar(ORDEN, MONTO);
        (,,,, bool pagada,,) = pago.ordenes(ORDEN);
        assertTrue(pagada);
    }

    function test_PagarOrden_RevierteAlCaducar() public {
        _crear(ORDEN, MONTO);
        vm.warp(block.timestamp + VIGENCIA);
        vm.startPrank(comprador);
        mxnb.approve(address(pago), MONTO);
        vm.expectRevert(PagoAtomicoMXNB.OrdenExpirada.selector);
        pago.pagarOrden(ORDEN);
        vm.stopPrank();
    }

    function test_PagarOrden_RevierteEnPausa() public {
        _crear(ORDEN, MONTO);
        vm.prank(owner);
        pago.pausar();
        vm.startPrank(comprador);
        mxnb.approve(address(pago), MONTO);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pago.pagarOrden(ORDEN);
        vm.stopPrank();
    }

    function test_PagarOrden_RevierteSinAllowanceSuficiente() public {
        _crear(ORDEN, MONTO);
        uint256 parteCreador = MONTO - (uint256(MONTO) * COMISION) / 10_000;
        vm.startPrank(comprador);
        mxnb.approve(address(pago), MONTO - 1);
        // El primer traspaso (al creador) cabe; el segundo (a tesorería) se queda corto por 1.
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector,
                address(pago),
                MONTO - 1 - parteCreador,
                MONTO - parteCreador
            )
        );
        pago.pagarOrden(ORDEN);
        vm.stopPrank();

        // La reversión deshace todo: la orden sigue pendiente y no se movió dinero.
        (,,,, bool pagada,,) = pago.ordenes(ORDEN);
        assertFalse(pagada);
        assertEq(mxnb.balanceOf(creador), 0);
    }

    function testFuzz_PagarOrden_RepartoCuadra(uint128 monto, uint16 bps) public {
        monto = uint128(bound(monto, 1, type(uint128).max));
        bps = uint16(bound(bps, 0, pago.COMISION_MAXIMA_BPS()));

        vm.prank(owner);
        pago.setComisionBps(bps);
        mxnb.mint(comprador, monto);
        _crear(ORDEN, monto);
        _pagar(ORDEN, monto);

        uint256 plataforma = (uint256(monto) * bps) / 10_000;
        assertEq(mxnb.balanceOf(tesoreria), plataforma);
        assertEq(mxnb.balanceOf(creador), monto - plataforma);
        assertEq(mxnb.balanceOf(creador) + mxnb.balanceOf(tesoreria), monto);
        assertEq(mxnb.balanceOf(address(pago)), 0);
    }

    // ───────────── cancelarOrden ─────────────

    function test_CancelarOrden_MarcaYEmite() public {
        _crear(ORDEN, MONTO);
        vm.expectEmit(true, false, false, false, address(pago));
        emit PagoAtomicoMXNB.OrdenCancelada(ORDEN);
        vm.prank(operador);
        pago.cancelarOrden(ORDEN);
        (,,,,, bool cancelada,) = pago.ordenes(ORDEN);
        assertTrue(cancelada);
    }

    function test_CancelarOrden_SoloOperador() public {
        _crear(ORDEN, MONTO);
        vm.prank(atacante);
        vm.expectRevert(PagoAtomicoMXNB.NoAutorizado.selector);
        pago.cancelarOrden(ORDEN);
    }

    function test_CancelarOrden_RevierteSiNoExiste() public {
        vm.prank(operador);
        vm.expectRevert(PagoAtomicoMXNB.OrdenInexistente.selector);
        pago.cancelarOrden(ORDEN);
    }

    function test_CancelarOrden_RevierteSiYaEstaPagada() public {
        _crear(ORDEN, MONTO);
        _pagar(ORDEN, MONTO);
        vm.prank(operador);
        vm.expectRevert(PagoAtomicoMXNB.OrdenNoPagable.selector);
        pago.cancelarOrden(ORDEN);
    }

    // ───────────── Administración ─────────────

    function test_Admin_SoloOwner() public {
        bytes memory error_ = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, atacante);
        vm.startPrank(atacante);
        vm.expectRevert(error_);
        pago.setTesoreria(atacante);
        vm.expectRevert(error_);
        pago.setOperador(atacante);
        vm.expectRevert(error_);
        pago.setComisionBps(0);
        vm.expectRevert(error_);
        pago.pausar();
        vm.expectRevert(error_);
        pago.reanudar();
        vm.expectRevert(error_);
        pago.rescatarTokens(IERC20(address(mxnb)), atacante, 1);
        vm.expectRevert(error_);
        pago.renounceOwnership();
        vm.stopPrank();
    }

    function test_Admin_ActualizaParametros() public {
        address nuevaTesoreria = makeAddr("nuevaTesoreria");
        address nuevoOperador = makeAddr("nuevoOperador");
        vm.startPrank(owner);
        pago.setTesoreria(nuevaTesoreria);
        pago.setOperador(nuevoOperador);
        pago.setComisionBps(pago.COMISION_MAXIMA_BPS());
        vm.stopPrank();
        assertEq(pago.tesoreria(), nuevaTesoreria);
        assertEq(pago.operador(), nuevoOperador);
        assertEq(pago.comisionBps(), pago.COMISION_MAXIMA_BPS());
    }

    function test_Admin_RevierteConDireccionCero() public {
        vm.startPrank(owner);
        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        pago.setTesoreria(address(0));
        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        pago.setOperador(address(0));
        vm.expectRevert(PagoAtomicoMXNB.DireccionInvalida.selector);
        pago.rescatarTokens(IERC20(address(mxnb)), address(0), 1);
        vm.stopPrank();
    }

    function test_Admin_ComisionNoPuedeSuperarElMaximo() public {
        uint16 maximo = pago.COMISION_MAXIMA_BPS();
        vm.prank(owner);
        vm.expectRevert(PagoAtomicoMXNB.ComisionInvalida.selector);
        pago.setComisionBps(maximo + 1);
    }

    function test_Admin_ReanudarTrasPausa() public {
        vm.startPrank(owner);
        pago.pausar();
        assertTrue(pago.paused());
        pago.reanudar();
        assertFalse(pago.paused());
        vm.stopPrank();
        _crear(ORDEN, MONTO);
        _pagar(ORDEN, MONTO);
    }

    function test_Admin_RenunciaDeshabilitada() public {
        vm.prank(owner);
        vm.expectRevert(PagoAtomicoMXNB.RenunciaDeshabilitada.selector);
        pago.renounceOwnership();
        assertEq(pago.owner(), owner);
    }

    function test_Admin_TransferenciaEnDosPasos() public {
        address nuevoOwner = makeAddr("nuevoOwner");
        vm.prank(owner);
        pago.transferOwnership(nuevoOwner);
        assertEq(pago.owner(), owner);
        assertEq(pago.pendingOwner(), nuevoOwner);

        vm.prank(nuevoOwner);
        pago.acceptOwnership();
        assertEq(pago.owner(), nuevoOwner);
    }

    function test_Admin_RescatarTokens() public {
        vm.prank(comprador);
        mxnb.transfer(address(pago), MONTO); // envío accidental

        address destino = makeAddr("destino");
        vm.expectEmit(true, true, false, true, address(pago));
        emit PagoAtomicoMXNB.TokensRescatados(address(mxnb), destino, MONTO);
        vm.prank(owner);
        pago.rescatarTokens(IERC20(address(mxnb)), destino, MONTO);

        assertEq(mxnb.balanceOf(destino), MONTO);
        assertEq(mxnb.balanceOf(address(pago)), 0);
    }
}
